import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { power_user } from "../../../power-user.js";
import { promptManager } from "../../../openai.js";
import { eventSource, event_types, streamingProcessor } from "../../../../script.js";
import { Handlebars } from "../../../../lib.js";

const { callPopup } = getContext();

const extensionName = "TTSSorcery";
// I only run inside SillyTavern. The imports above point at the host by
// relative path, three and four levels up, so this file cannot load on
// its own and moving it breaks every import at once.
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const extensionSettings = extension_settings[extensionName];
// These defaults only land when the stored settings object is completely
// empty (see loadSettings). If even one key survived from an older
// install, the rest stay undefined and the reads further down fall back
// with || instead.
const defaultSettings = {
    enabled: false,
    api_key: "",
    model: "zonos-v0.1-hybrid",
    language_iso_code: "en-us",
    speaking_rate: 15,
    vqscore: 0.78,
    speaker_noised: false,
    disable_narrator: false,
    action_handling: "narrator",
    max_preload: 5,
    segment_gap: 0.5,
    auto_generation: false,
    force_neutral_narrator: false,
    presets: [
        {
            name: "Default",
            model: "zonos-v0.1-hybrid",
            language_iso_code: "en-us",
            speaking_rate: 15,
            vqscore: 0.78,
            speaker_noised: false
        }
    ],
    active_preset: "Default"
};

function generateCharacterList() {
    // I only list variants that actually hold a file. A variant the user
    // created but never filled would tell the model to ask for a voice
    // file that does not exist, and playback falls back to default.mp3
    // in the end anyway.
    const voices = extension_settings[extensionName].voices;
    if (!voices) return '';

    let characterList = [];
    
    for (const [voiceId, voice] of Object.entries(voices)) {
        if (!voice?.audioFiles) continue;

        const variants = Object.entries(voice.audioFiles)
            .filter(([_, audio]) => audio && audio.file !== null)
            .map(([variantName, _]) => variantName);

        if (variants.length > 0) {
            characterList.push(`${voice.name} - ${variants.map(v => `${v}.mp3`).join(', ')}`);
        }
    }

    return characterList.join('\n');
}

// This whole block is pasted into the prompt on every generation (see
// injectInstructions). The model is the unreliable half of this design:
// if it places a marker wrong, extractTTSInfo finds nothing and the
// message stays silent. Nothing downstream can recover a bad marker.
const INSTRUCTIONS_TEMPLATE = `
-----

!!! IMPORTANT TTS INSTRUCTIONS !!!

The following are instructions for inserting TTS markers into your responses. You will ALWAYS insert these TTS markers in the text.
Read them VERY carefully and follow them to the letter:

AVAILABLE CHARACTERS AND VOICE FILES:
{{CHARACTER_LIST}}

MARKER EXPLANATION:
- §n|voiceFile.mp3|emotionValues§ = Narrator speaking
- §a§ = Action description (Another narrator but without the emotion values)
- §c:CharacterName|voiceFile.mp3|emotionValues§ = Character speaking

EMOTION VALUES EXPLANATION:
- e1: Happiness (0.0-1.0)
- e2: Sadness (0.0-1.0)
- e3: Disgust (0.0-1.0)
- e4: Fear (0.0-1.0)
- e5: Surprise (0.0-1.0)
- e6: Anger (0.0-1.0)
- e7: Other (0.0-1.0)
- e8: Neutral (0.0-1.0)

EXAMPLE:
*§n|narrator.mp3|e1:0.1,e8:0.9§The sun was setting over the quiet village as the travelers approached the inn.*

*§a§A young woman with golden hair steps forward, her cloak billowing in the evening breeze.*

"§c:Elara|female_young.mp3|e1:0.7,e5:0.3§Welcome to Rivermist Inn!" *§a§she says with a warm smile, gesturing toward the entrance.* "§c:Elara§We have rooms available if you're looking to stay the night."

*§a§An older man appears in the doorway, wiping his hands on his apron.*

"§c:Innkeeper|male_gruff.mp3|e6:0.3,e8:0.7§Elara! Don't just stand there, help our guests with their bags!" *§n|e2:0.2,e8:0.8§The night promises to be interesting as you sense tension between the two.*

When inserting these markers:
- Place them exactly where the narration, action, or dialogue begins
- Use the complete format for the first appearance of each character
- For subsequent appearances, you can use shorter versions like §c:CharacterName§ if the voice and emotions remain the same
- Don't place markers inside quotes unless the marker itself is for dialogue
- Use appropriate emotion values based on the context
- If a character in a marker is not found from the given list above, it will default to Narrator + default.mp3
- If a given voice file is not found from the given list above / doesn't correspond with the character, it will default to default.mp3
- If the only available character is Narrator, just use it for everything

-----
`;

function getCurrentInstructions() {
    const characterList = generateCharacterList();
    return INSTRUCTIONS_TEMPLATE.replace('{{CHARACTER_LIST}}', characterList || 'Narrator - default.mp3');
}

let instructionsInjected = false;
let hookInstalled = false;
// The stream hook keeps the host callback and my wrapper so the hook
// can be taken back out. Without these, a reset could only clear the
// flag and the next install would wrap my own wrapper again.
let originalOnProgressStreaming = null;
let streamHookWrapper = null;

// pageLoadTimestamp is written here and in resetExtensionState, and read
// nowhere else in this file. It is leftover bookkeeping, not a gate that
// anything checks.
let pageLoadTimestamp = Date.now();

// lastProcessedMessageId is the dedupe key for auto generation. Once a
// message id is recorded here, processSegments refuses to speak that
// message again. The stream hook clears it when a new message starts.
let lastProcessedMessageId = null;

function injectInstructions(data) {
    // I push a full user message onto data.chat instead of editing the
    // system prompt. The prompt ready event hands me the chat array, so
    // pushing onto it is the lever I actually have here.
    if (!extension_settings[extensionName].enabled) return;
    
    console.log(`${extensionName}: Injecting TTS instructions`);
    
    data.chat.push({
        role: 'user',
        content: getCurrentInstructions()
    });
    
    instructionsInjected = true;
}

function extractTTSInfo(text) {
    console.log("Extracting TTS info from:", text.substring(0, 100) + "...");
    
    const markers = [];
    // The marker grammar is: section sign, one of n, a, or c, then an
    // optional :name, an optional |voice file, an optional |emotions,
    // and a closing section sign. Every group after the type letter is
    // optional, so a short marker still parses and the defaults below
    // fill in Narrator and default.mp3.
    const markerRegex = /§([nac])(:([^§|]*))?(\|([^§|]*))?(\|([^§]*))?§/g;
    
    let match;
    while ((match = markerRegex.exec(text)) !== null) {
        console.log("Found marker:", match[0]);
        
        const type = match[1];
        let character = 'Narrator';
        let voiceFile = 'default.mp3';
        let emotions = {};
        
        if (type === 'c' && match[3]) {
            character = match[3];
        }
        
        if (match[5]) {
            voiceFile = match[5];
        }
        
        if (match[7]) {
            const emotionStr = match[7];
            const emotionPairs = emotionStr.split(',');
            
            emotionPairs.forEach(pair => {
                const [key, value] = pair.split(':');
                if (key && value) {
                    emotions[key] = parseFloat(value);
                }
            });
        }
        
        markers.push({
            type,
            character,
            voiceFile,
            emotions,
            position: match.index,
            fullMatch: match[0]
        });
    }
    
    console.log(`Found ${markers.length} markers`);
    return markers;
}

function logTTSInfo(markers) {
    markers.forEach(marker => {
        let logMessage = '';
        
        switch (marker.type) {
            case 'n':
                logMessage = `Narrator speaking with voice ${marker.voiceFile}`;
                break;
            case 'a':
                logMessage = 'Action description';
                break;
            case 'c':
                logMessage = `Character ${marker.character} speaking with voice ${marker.voiceFile}`;
                break;
        }
        
        if (Object.keys(marker.emotions).length > 0) {
            logMessage += ' with emotions: ';
            const emotionStrings = [];
            
            for (const [key, value] of Object.entries(marker.emotions)) {
                let emotionName = key;
                switch (key) {
                    case 'e1': emotionName = 'Happiness'; break;
                    case 'e2': emotionName = 'Sadness'; break;
                    case 'e3': emotionName = 'Disgust'; break;
                    case 'e4': emotionName = 'Fear'; break;
                    case 'e5': emotionName = 'Surprise'; break;
                    case 'e6': emotionName = 'Anger'; break;
                    case 'e7': emotionName = 'Other'; break;
                    case 'e8': emotionName = 'Neutral'; break;
                }
                
                emotionStrings.push(`${emotionName}: ${value}`);
            }
            
            logMessage += emotionStrings.join(', ');
        }
        
        console.log(`TTS Marker: ${logMessage}`);
    });
}

// Nothing in this file calls fixFormatting. It only logs the markers it
// finds and squeezes spaces around asterisks and quotes. I leave it here
// as it is rather than pretend it sits in the live path.
function fixFormatting(text) {
    const markers = extractTTSInfo(text);
    
    if (markers.length > 0) {
        console.log("Logging TTS info:");
        logTTSInfo(markers);
    }
    
    let processedText = text
        .replace(/\* +/g, '*')
        .replace(/ +\*/g, '*')
        .replace(/" +/g, '"')
        .replace(/ +"/g, '"')
        .replace(/\*"/g, '* "')
        .replace(/"\*/g, '" *');
    
    return processedText;
}

function uninstallStreamHook() {
    // Put the host callback back, but only while mine is the one
    // currently installed. If something else replaced it after me, I
    // leave that alone and just clear my bookkeeping.
    if (streamHookWrapper && streamingProcessor.onProgressStreaming === streamHookWrapper) {
        streamingProcessor.onProgressStreaming = originalOnProgressStreaming;
    }
    originalOnProgressStreaming = null;
    streamHookWrapper = null;
    hookInstalled = false;
}

function installStreamHook() {
    // I wrap the host streaming callback instead of replacing it, and the
    // wrapper calls the original at the end of every update. The wrapper
    // is stored in streamHookWrapper so uninstallStreamHook can put the
    // original back; a reset that only cleared the flag would leave my
    // wrapper in place for the next install to wrap again.
    if (hookInstalled || !extension_settings[extensionName].enabled) return;
    if (!extension_settings[extensionName].auto_generation) return;

    console.log(`${extensionName}: Installing stream hook`);

    originalOnProgressStreaming = streamingProcessor.onProgressStreaming;
    const originalOnProgressStreamingLocal = originalOnProgressStreaming;
    
    let lastProcessedLength = 0;
    
    let textBuffer = '';
    let lastProcessedParagraphEnd = 0;
    
    let allSegments = [];
    let lastStreamTimestamp = Date.now();
    
    streamingProcessor.onProgressStreaming = function(messageId, text, isFinal) {
        console.log(`Stream update: ${text.length} chars, isFinal: ${isFinal}`);
        
        // lastStreamTimestamp is updated here and read nowhere else in
        // this file. The write stays, the tracking I planned for it was
        // never built.
        lastStreamTimestamp = Date.now();
        
        // A one character update is my signal that a new message
        // started. It is a guess about how the host streams: a message
        // whose first chunk arrives longer than one character never
        // clears the old id here, and the dedupe in processSegments
        // decides what happens to it instead.
        if (text.length === 1) {
            lastProcessedMessageId = null;
            console.log("New message streaming started, cleared last processed message ID");
        }
        
        textBuffer = text;
        
        if (text.length > lastProcessedLength) {
            const newContent = text.substring(lastProcessedLength);
            console.log(`New content (${newContent.length} chars): ${newContent.substring(0, 50)}...`);
            lastProcessedLength = text.length;
            
            const markers = extractTTSInfo(newContent);
            if (markers.length > 0) {
                console.log(`New TTS markers found:`);
                logTTSInfo(markers);
            }
        }
        
        // I only cut segments at an asterisk or a quote followed by a
        // newline or the end of the text. A paragraph that never closes
        // its formatting is never cut here. The isFinal branch below
        // takes whatever is left whole.
        const paragraphEndRegex = /[*"]\s*(?:\n|$)/g;
        let match;
        
        paragraphEndRegex.lastIndex = lastProcessedParagraphEnd;
        
        while ((match = paragraphEndRegex.exec(textBuffer)) !== null) {
            const paragraph = textBuffer.substring(lastProcessedParagraphEnd, match.index + match[0].length);
            const markers = extractTTSInfo(paragraph);
            
            if (markers.length > 0) {
                const segments = processSegments(paragraph, markers);
                allSegments.push(...segments);
            }
            
            lastProcessedParagraphEnd = match.index + match[0].length;
        }
        
        if (isFinal) {
            const remainingText = textBuffer.substring(lastProcessedParagraphEnd);
            if (remainingText.trim()) {
                const markers = extractTTSInfo(remainingText);
                if (markers.length > 0) {
                    const segments = processSegments(remainingText, markers);
                    allSegments.push(...segments);
                }
            }
            
            if (allSegments.length > 0) {
                console.log('\n=== TTS PROCESSING SUMMARY ===');
                console.log('Complete message broken into TTS segments:');
                allSegments.forEach((segment, index) => {
                    console.log(`\n[Segment ${index + 1}]`);
                    console.log(`Type: ${segment.type}`);
                    console.log(`Text: ${segment.text}`);
                    if (segment.character) console.log(`Character: ${segment.character}`);
                    if (segment.voiceFile) console.log(`Voice File: ${segment.voiceFile}`);
                    if (Object.keys(segment.emotions).length > 0) {
                        console.log(`Emotions: ${formatEmotions(segment.emotions)}`);
                    }
                });
                console.log('\n=== END SUMMARY ===\n');
            }
            
            textBuffer = '';
            lastProcessedParagraphEnd = 0;
            lastProcessedLength = 0;
            allSegments = [];
        }
        
        return originalOnProgressStreamingLocal.call(this, messageId, text, isFinal);
    };

    streamHookWrapper = streamingProcessor.onProgressStreaming;
    hookInstalled = true;
}

let ttsQueue = [];
let isPlayingTts = false;
let currentAudio = null;
let preloadedAudios = [];
let loadingSegments = new Set();
let currentPlayingSegmentIndex = -1;

function resetTtsQueue(force = false) {
    // A non-forced reset leaves the queue alone: the caller is saying
    // playback may continue, so I log that and return. Every caller in
    // this file that actually wants the queue cleared passes force as
    // true.
    if (force) {
        console.log("Resetting TTS queue and stopping playback");

        if (currentAudio) {
            currentAudio.pause();
            currentAudio.onended = null;
            currentAudio = null;
        }
        
        preloadedAudios.forEach(item => {
            if (item.audio) {
                item.audio.pause();
                item.audio.onended = null;
                URL.revokeObjectURL(item.audio.src);
            }
        });
        preloadedAudios = [];
        loadingSegments.clear();
        
        ttsQueue = [];
        currentPlayingSegmentIndex = -1;
        isPlayingTts = false;
        updateTTSSorceryPlaybackUI();
    } else {
        console.log("Not resetting TTS queue - allowing playback to continue");
    }
}

// The chat loaded handlers call this. It is the full reset: queue,
// injection flag, hook flag, and the dedupe id all go back to their
// starting values because a new chat must not inherit any of them.
function resetExtensionState() {
    console.log("Completely resetting TTSSorcery extension state");
    resetTtsQueue(true);
    instructionsInjected = false;
    uninstallStreamHook();
    pageLoadTimestamp = Date.now();
    lastProcessedMessageId = null;
}

function processSegments(text, markers) {
    if (!extension_settings[extensionName].enabled) {
        return [];
    }
    
    const currentChatId = getContext().chatId;
    console.log(`Processing TTS segments for chat ID: ${currentChatId}`);
    
    // If auto-generation is enabled, only process the most recent message
    if (extension_settings[extensionName].auto_generation) {
        const context = getContext();
        
        // Get the most recent non-user message in the chat
        let latestMessage = null;
        if (context.chat && context.chat.length > 0) {
            for (let i = context.chat.length - 1; i >= 0; i--) {
                if (!context.chat[i].is_user) {
                    latestMessage = context.chat[i];
                    break;
                }
            }
        }
        
        // If we have a latest message and its ID matches our last processed ID, skip it
        if (latestMessage && latestMessage.mes_id === lastProcessedMessageId) {
            console.log(`Skipping already processed message ID: ${lastProcessedMessageId}`);
            return [];
        }
        
        // If we're processing a message directly (not through the stream hook),
        // check if it's the latest message
        // The manual path is recognised by absence: if no message id has
        // been recorded yet, I assume a button press and let the text
        // through even when it is not the latest message text.
        const messageIsFromManualButton = !lastProcessedMessageId;
        if (!messageIsFromManualButton && latestMessage && latestMessage.mes !== text) {
            console.log(`Skipping non-latest message. Only processing the most recent response.`);
            return [];
        }
        
        // Update the last processed message ID
        if (latestMessage) {
            lastProcessedMessageId = latestMessage.mes_id;
            console.log(`Now processing latest message ID: ${lastProcessedMessageId}`);
        }
    }
    
    markers.sort((a, b) => a.position - b.position);
    
    function sanitizeText(text) {
        // I strip the markup before any text leaves the page.
        // Asterisks and quotes are stage directions for the reader, not
        // words for the speaker, so they do not go to the API. The
        // order matters: the double hyphen rule runs first, the
        // character strip runs before the hyphen between words rule,
        // and each later rule only sees what the earlier ones left.
        text = text.replace(/--/g, '—');
        text = text.replace(/[\*\"]/g, '');
        text = text.replace(/\s+/g, ' ');
        text = text.replace(/[^a-zA-Z0-9\s.,!?'();\-–—]/g, '');
        text = text.replace(/(\w)-(\w)/g, '$1–$2');
        text = text.replace(/\b-+/g, '—');
        text = text.replace(/\s+-+/g, ' —');
        text = text.replace(/—+/g, '—');
        text = text.replace(/–+/g, '–');
        text = text.replace(/\s*—\s*/g, ' — ');
        return text.trim();
    }
    
    let segments = [];
    let lastCharacterMarker = null;

    if (markers.length === 0 && text.trim()) {
        segments.push({
            type: 'a',
            character: 'Narrator',
            voiceFile: 'default.mp3',
            emotions: {},
            text: sanitizeText(text),
            chatId: currentChatId
        });
        return segments;
    }

    markers.forEach((marker, index) => {
        let endPos = index < markers.length - 1 ? markers[index + 1].position : text.length;
        let segmentText = text.substring(marker.position + marker.fullMatch.length, endPos);
        
        if (marker.type === 'c') {
            lastCharacterMarker = marker;
        }

        if (marker.type === 'c') {
            const dialogueActionRegex = /^(.*?)"\s*\*([^*]*)\*\s*"(.*?)$/;
            const match = segmentText.match(dialogueActionRegex);
            
            if (match) {
                const firstDialogue = match[1].replace(/^"|"$/g, '').trim();
                if (firstDialogue) {
                    segments.push({
                        type: 'c',
                        character: marker.character,
                        voiceFile: marker.voiceFile,
                        emotions: marker.emotions,
                        text: sanitizeText(firstDialogue),
                        chatId: currentChatId
                    });
                }
                
                const actionText = match[2].trim();
                if (actionText) {
                    segments.push({
                        type: 'a',
                        character: 'Narrator',
                        voiceFile: 'default.mp3',
                        emotions: {},
                        text: sanitizeText(actionText),
                        chatId: currentChatId
                    });
                }
                
                const secondDialogue = match[3].replace(/^"|"$/g, '').trim();
                if (secondDialogue) {
                    segments.push({
                        type: 'c',
                        character: marker.character,
                        voiceFile: marker.voiceFile,
                        emotions: marker.emotions,
                        text: sanitizeText(secondDialogue),
                        chatId: currentChatId
                    });
                }
            } else {
                const dialogueActionEndRegex = /^(.*?)"\s*\*([^*]*)\*$/;
                const matchEnd = segmentText.match(dialogueActionEndRegex);
                
                if (matchEnd) {
                    const dialogueText = matchEnd[1].replace(/^"|"$/g, '').trim();
                    if (dialogueText) {
                        segments.push({
                            type: 'c',
                            character: marker.character,
                            voiceFile: marker.voiceFile,
                            emotions: marker.emotions,
                            text: sanitizeText(dialogueText),
                            chatId: currentChatId
                        });
                    }
                    
                    const actionText = matchEnd[2].trim();
                    if (actionText) {
                        segments.push({
                            type: 'a',
                            character: 'Narrator',
                            voiceFile: 'default.mp3',
                            emotions: {},
                            text: sanitizeText(actionText),
                            chatId: currentChatId
                        });
                    }
                } else {
                    const dialogueText = segmentText.replace(/^"|"$/g, '').trim();
                    if (dialogueText) {
                        segments.push({
                            type: 'c',
                            character: marker.character,
                            voiceFile: marker.voiceFile,
                            emotions: marker.emotions,
                            text: sanitizeText(dialogueText),
                            chatId: currentChatId
                        });
                    }
                }
            }
        } else if (marker.type === 'a') {
            const actionDialogueRegex = /^([^"]*)"([^"]*)"(.*)$/;
            const match = segmentText.match(actionDialogueRegex);
            
            if (match && lastCharacterMarker) {
                const firstAction = match[1].replace(/\*$/g, '').trim();
                if (firstAction) {
                    segments.push({
                        type: 'a',
                        character: 'Narrator',
                        voiceFile: 'default.mp3',
                        emotions: {},
                        text: sanitizeText(firstAction),
                        chatId: currentChatId
                    });
                }
                
                const dialogueText = match[2].trim();
                if (dialogueText) {
                    segments.push({
                        type: 'c',
                        character: lastCharacterMarker.character,
                        voiceFile: lastCharacterMarker.voiceFile,
                        emotions: lastCharacterMarker.emotions,
                        text: sanitizeText(dialogueText),
                        chatId: currentChatId
                    });
                }
                
                const secondAction = match[3].replace(/\*$/g, '').trim();
                if (secondAction) {
                    segments.push({
                        type: 'a',
                        character: 'Narrator',
                        voiceFile: 'default.mp3',
                        emotions: {},
                        text: sanitizeText(secondAction),
                        chatId: currentChatId
                    });
                }
            } else {
                const actionText = segmentText.replace(/\*$/g, '').trim();
                if (actionText) {
                    segments.push({
                        type: 'a',
                        character: 'Narrator',
                        voiceFile: 'default.mp3',
                        emotions: {},
                        text: sanitizeText(actionText),
                        chatId: currentChatId
                    });
                }
            }
        } else {
            // Narrator markers land here. The segment takes its
            // emotions from the marker, the same as the character and
            // action branches above.
            segments.push({
                type: marker.type,
                character: marker.character,
                voiceFile: marker.voiceFile,
                emotions: marker.emotions,
                text: sanitizeText(segmentText),
                chatId: currentChatId
            });
        }
    });

    // Returning the segments is only half of what this function does.
    // It also pushes every segment onto the shared ttsQueue here and
    // starts playback when the queue is idle, so a caller cannot use it
    // just to inspect a message without speaking it.
    segments.forEach(segment => {
        console.log(`\n[Streaming Segment]`);
        console.log(`Type: ${segment.type}`);
        console.log(`Text: ${segment.text}`);
        if (segment.character) console.log(`Character: ${segment.character}`);
        if (segment.voiceFile) console.log(`Voice File: ${segment.voiceFile}`);
        if (Object.keys(segment.emotions).length > 0) {
            console.log(`Emotions: ${formatEmotions(segment.emotions)}`);
        }
        console.log("============================================================================================")
        
        ttsQueue.push(segment);
    });
    
    if (!isPlayingTts) {
        processTtsQueue();
    }

    return segments;
}

function processTtsQueue() {
    if (ttsQueue.length === 0) {
        console.log("TTS queue is empty, nothing to process");
        return;
    }
    
    if (isPlayingTts) {
        preloadTtsSegments();
        return;
    }
    
    isPlayingTts = true;
    currentPlayingSegmentIndex = 0;
    
    const preloadedIndex = preloadedAudios.findIndex(item => item.index === currentPlayingSegmentIndex);
    if (preloadedIndex >= 0) {
        playPreloadedSegment(preloadedIndex);
    } else {
        if (!loadingSegments.has(currentPlayingSegmentIndex)) {
            loadAndPlaySegment(currentPlayingSegmentIndex);
        }
    }
    
    preloadTtsSegments();
}

function preloadTtsSegments() {
    if (!isPlayingTts) return;
    
    const currentIndex = currentPlayingSegmentIndex;
    
    if (currentIndex < 0 || currentIndex >= ttsQueue.length) {
        return;
    }
    
    console.log(`Preload status: Playing segment ${currentIndex+1}/${ttsQueue.length}, preloaded: ${preloadedAudios.length}, loading: ${loadingSegments.size}`);
    
    const startIdx = currentIndex + 1;
    const endIdx = Math.min(startIdx + extension_settings[extensionName].max_preload, ttsQueue.length);
    
    for (let i = startIdx; i < endIdx; i++) {
        if (preloadedAudios.some(item => item.index === i) || loadingSegments.has(i)) {
            continue;
        }
        
        console.log(`Starting preload for segment ${i+1}/${ttsQueue.length}`);
        loadingSegments.add(i);
        preloadTtsSegment(i);
    }
}

function playPreloadedSegment(preloadedIndex) {
    const preloaded = preloadedAudios[preloadedIndex];
    preloadedAudios.splice(preloadedIndex, 1);
    
    console.log(`Playing preloaded TTS for segment ${preloaded.index + 1}`);
    
    currentAudio = preloaded.audio;
    currentAudio.onended = () => {
        console.log(`Finished playing TTS segment ${preloaded.index + 1}/${ttsQueue.length}`);
        currentAudio = null;
        
        currentPlayingSegmentIndex++;
        
        const nextPreloadedIndex = preloadedAudios.findIndex(item => item.index === currentPlayingSegmentIndex);
        
        if (nextPreloadedIndex >= 0) {
            setTimeout(() => playPreloadedSegment(nextPreloadedIndex), extension_settings[extensionName].segment_gap * 1000);
        } else if (currentPlayingSegmentIndex < ttsQueue.length) {
            if (loadingSegments.has(currentPlayingSegmentIndex)) {
                console.log(`Waiting for segment ${currentPlayingSegmentIndex + 1} to finish preloading`);
            } else {
                setTimeout(() => loadAndPlaySegment(currentPlayingSegmentIndex), extension_settings[extensionName].segment_gap * 1000);
            }
        } else {
            isPlayingTts = false;
            currentPlayingSegmentIndex = -1;
            updateTTSSorceryPlaybackUI();
        }
        
        preloadTtsSegments();
    };
    
    currentAudio.play().catch(error => {
        console.error("Error playing audio:", error);
        currentAudio = null;
        currentPlayingSegmentIndex++;
        processTtsQueue();
    });
    
    updateTTSSorceryPlaybackUI();
}

function loadAndPlaySegment(index) {
    if (index >= ttsQueue.length) {
        console.log("All TTS segments complete");
        currentPlayingSegmentIndex = -1;
        isPlayingTts = false;
        updateTTSSorceryPlaybackUI();
        return;
    }
    
    currentPlayingSegmentIndex = index;
    
    const segment = ttsQueue[index];

    // Segments remember the chat they were built from. If the user
    // switched chats while audio was still queued, I skip the segment
    // instead of playing lines from the old chat into the new one. The
    // preload function below repeats this same check for its own path.
    const currentChatId = getContext().chatId;
    if (segment.chatId && segment.chatId !== currentChatId) {
        console.log(`Skipping segment ${index+1} - chat ID mismatch (segment: ${segment.chatId}, current: ${currentChatId})`);
        setTimeout(() => {
            loadAndPlaySegment(index + 1);
        }, 100);
        return;
    }
    
    const shouldSkipNarrator = extension_settings[extensionName].disable_narrator && 
                              segment.character === 'Narrator' && 
                              segment.type === 'n';
                              
    const shouldSkipAction = extension_settings[extensionName].action_handling === 'silence' && 
                            segment.type === 'a';
    
    if (shouldSkipNarrator || shouldSkipAction) {
        console.log(`Skipping segment ${index+1} (${shouldSkipNarrator ? 'Narrator disabled' : 'Action silenced'})`);
        setTimeout(() => {
            loadAndPlaySegment(index + 1);
        }, 100);
        return;
    }
    
    const preloadedIndex = preloadedAudios.findIndex(item => item.index === index);
    if (preloadedIndex >= 0) {
        const preloaded = preloadedAudios[preloadedIndex];
        preloadedAudios.splice(preloadedIndex, 1);
    
        console.log(`Playing preloaded TTS for: ${preloaded.segment.character} - ${preloaded.segment.text.substring(0, 30)}${preloaded.segment.text.length > 30 ? '...' : ''}`);
        
        currentAudio = preloaded.audio;
        currentAudio.onended = () => {
            console.log(`Finished playing TTS segment ${index+1}/${ttsQueue.length}`);
            currentAudio = null;
            
            preloadTtsSegments();
            
            setTimeout(() => {
                loadAndPlaySegment(index + 1);
            }, extension_settings[extensionName].segment_gap * 1000);
        };
        
        currentAudio.play().catch(error => {
            console.error("Error playing audio:", error);
            currentAudio = null;
            
            setTimeout(() => {
                loadAndPlaySegment(index + 1);
            }, 100);
        });
        
        updateTTSSorceryPlaybackUI();
        
        preloadTtsSegments();
        
        return;
    }
    
    console.log(`Loading and playing TTS for: ${segment.character} - ${segment.text.substring(0, 30)}${segment.text.length > 30 ? '...' : ''}`);
    
    let voiceId = 'narrator';
    let audioVariant = 'default';
    
    const voices = extension_settings[extensionName].voices;
    if (segment.character !== 'Narrator') {
        for (const [id, voice] of Object.entries(voices)) {
            if (voice.name === segment.character) {
                voiceId = id;
                break;
            }
        }
    }
    
    if (segment.voiceFile && segment.voiceFile !== 'default.mp3') {
        audioVariant = segment.voiceFile.replace('.mp3', '');
    }
    
    if (!voices[voiceId] || !voices[voiceId].audioFiles || !voices[voiceId].audioFiles[audioVariant]) {
        console.warn(`Voice not found: ${segment.character}, variant: ${audioVariant}, falling back to narrator/default`);
        voiceId = 'narrator';
        audioVariant = 'default';
    }
    
    const audioData = voices[voiceId]?.audioFiles[audioVariant]?.file;
    if (!audioData) {
        console.error(`No audio file found for ${segment.character}, variant: ${audioVariant}`);
        toastr.error(`No voice sample for ${segment.character}`);
        
        setTimeout(() => {
            loadAndPlaySegment(index + 1);
        }, 100);
        return;
    }
    
    const emotions = mapEmotionsToZyphraFormat(segment.emotions);

    if (extension_settings[extensionName].force_neutral_narrator && 
        (segment.character === 'Narrator' || segment.type === 'n' || segment.type === 'a')) {
        console.log("Forcing neutral emotions for narrator");
        Object.keys(emotions).forEach(key => delete emotions[key]);
        emotions.neutral = 1.0;
    }
    
    const apiKey = extension_settings[extensionName].api_key;
    if (!apiKey) {
        console.error("No API key set for TTSSorcery");
        toastr.error("Please set your Zyphra API key in TTSSorcery settings");
        resetTtsQueue(true);
        return;
    }

    // I pad the text with ellipses on both ends before sending it, so
    // the synthesis has a lead in and a trail off instead of starting
    // and stopping hard on the words themselves. The guards here stop a
    // segment that already carries dots from collecting more every time
    // it passes through this function. This mutates the queued segment,
    // which is why the guard has to live in the same place as the
    // padding.
    if (segment.text) {
        if (!segment.text.startsWith('...') && !segment.text.startsWith(' ...')) {
            segment.text = '... ' + segment.text;
        }
        
        if (!segment.text.endsWith('...') && !segment.text.endsWith('... ')) {
            segment.text = segment.text + ' ...';
        }
    }
    
    const requestData = {
        text: segment.text,
        speaking_rate: extension_settings[extensionName].speaking_rate,
        model: extension_settings[extensionName].model,
        language_iso_code: extension_settings[extensionName].language_iso_code,
        mime_type: "audio/webm",
        speaker_audio: getBase64AudioData(audioData)
    };
    
    if (Object.keys(emotions).length > 0) {
        requestData.emotion = emotions;
    }
    
    if (extension_settings[extensionName].model === "zonos-v0.1-hybrid") {
        requestData.vqscore = extension_settings[extensionName].vqscore || 0.78;
        requestData.speaker_noised = extension_settings[extensionName].speaker_noised;
    }
    
    
    // The log line below prints the request with speaker_audio replaced
    // by a marker, so the cloned voice data stays out of the console.
    // The API key is not part of requestData and is not logged either.
    // It travels in the X-API-Key header over HTTPS, which is the only
    // auth this endpoint takes, and it is read from settings at call
    // time. No key value is stored in this file.
    console.log("Sending TTS request to Zyphra API:", { ...requestData, speaker_audio: "[BASE64_DATA]" });
    
    updateTTSSorceryPlaybackUI();
    
    fetch("https://api.zyphra.com/v1/audio/text-to-speech", {
        method: "POST",
        headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(requestData)
    })
    .then(response => {
        if (!response.ok) {
            return response.text().then(text => {
                throw new Error(`API request failed: ${response.status} - ${text}`);
            });
        }
        return response.blob();
    })
    .then(blob => {
        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);
        
        audio.onended = () => {
            console.log(`Finished playing TTS segment ${index+1}/${ttsQueue.length}`);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            
            preloadTtsSegments();
            
            setTimeout(() => {
                loadAndPlaySegment(index + 1);
            }, extension_settings[extensionName].segment_gap * 1000);
        };
        
        audio.onerror = (error) => {
            console.error("Error playing audio:", error);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            toastr.error("Error playing TTS audio");
            
            setTimeout(() => {
                loadAndPlaySegment(index + 1);
            }, 100);
        };
        
        currentAudio = audio;
        audio.play().catch(error => {
            console.error("Error starting audio playback:", error);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            toastr.error("Failed to play TTS audio");
            
            setTimeout(() => {
                loadAndPlaySegment(index + 1);
            }, 100);
        });
        
        updateTTSSorceryPlaybackUI();
        
        preloadTtsSegments();
    })
    .catch(error => {
        console.error("Error with TTS API:", error);
        toastr.error("TTS API Error: " + error.message);
        
        setTimeout(() => {
            loadAndPlaySegment(index + 1);
        }, 100);
    });
}

function preloadTtsSegment(index) {
    if (index >= ttsQueue.length) {
        loadingSegments.delete(index);
        return;
    }
    
    const segment = ttsQueue[index];

    const currentChatId = getContext().chatId;
    if (segment.chatId && segment.chatId !== currentChatId) {
        console.log(`Skipping preload for segment ${index+1} - chat ID mismatch (segment: ${segment.chatId}, current: ${currentChatId})`);
        loadingSegments.delete(index);
        return;
    }
    
    let voiceId = 'narrator';
    let audioVariant = 'default';
    
    const voices = extension_settings[extensionName].voices;
    if (segment.character !== 'Narrator') {
        for (const [id, voice] of Object.entries(voices)) {
            if (voice.name === segment.character) {
                voiceId = id;
                break;
            }
        }
    }

    if (segment.voiceFile && segment.voiceFile !== 'default.mp3') {
        audioVariant = segment.voiceFile.replace('.mp3', '');
    }
    
    if (!voices[voiceId] || !voices[voiceId].audioFiles || !voices[voiceId].audioFiles[audioVariant]) {
        console.warn(`Voice not found for preload: ${segment.character}, variant: ${audioVariant}, falling back to narrator/default`);
        voiceId = 'narrator';
        audioVariant = 'default';
    }
    
    const audioData = voices[voiceId]?.audioFiles[audioVariant]?.file;
    if (!audioData) {
        // Clear the loading mark before returning. Leaving the index in
        // loadingSegments would make preloadTtsSegments treat this
        // segment as still loading and never try it again.
        console.error(`No audio file found for preload: ${segment.character}, variant: ${audioVariant}`);
        loadingSegments.delete(index);
        return;
    }
    
    const emotions = mapEmotionsToZyphraFormat(segment.emotions);

    if (extension_settings[extensionName].force_neutral_narrator && 
        (segment.character === 'Narrator' || segment.type === 'n' || segment.type === 'a')) {
        console.log("Forcing neutral emotions for narrator");
        Object.keys(emotions).forEach(key => delete emotions[key]);
        emotions.neutral = 1.0;
    }
    
    const apiKey = extension_settings[extensionName].api_key;
    if (!apiKey) {
        console.error("No API key set for TTSSorcery preload");
        loadingSegments.delete(index);
        return;
    }

    console.log(`Preloading TTS segment ${index+1}: ${segment.character} - ${segment.text.substring(0, 30)}${segment.text.length > 30 ? '...' : ''}`);

    // I build the request body here, the same shape loadAndPlaySegment
    // sends, instead of naming a variable from that function. The
    // ellipses padding goes on a local copy of the text: the queued
    // segment itself stays unpadded, so the playback path can pad it
    // once if this preload never gets used.
    let preloadText = segment.text;
    if (preloadText) {
        if (!preloadText.startsWith('...') && !preloadText.startsWith(' ...')) {
            preloadText = '... ' + preloadText;
        }
        if (!preloadText.endsWith('...') && !preloadText.endsWith('... ')) {
            preloadText = preloadText + ' ...';
        }
    }

    const requestData = {
        text: preloadText,
        speaking_rate: extension_settings[extensionName].speaking_rate,
        model: extension_settings[extensionName].model,
        language_iso_code: extension_settings[extensionName].language_iso_code,
        mime_type: "audio/webm",
        speaker_audio: getBase64AudioData(audioData)
    };

    if (Object.keys(emotions).length > 0) {
        requestData.emotion = emotions;
    }

    if (extension_settings[extensionName].model === "zonos-v0.1-hybrid") {
        requestData.vqscore = extension_settings[extensionName].vqscore || 0.78;
        requestData.speaker_noised = extension_settings[extensionName].speaker_noised;
    }

    fetch("https://api.zyphra.com/v1/audio/text-to-speech", {
        method: "POST",
        headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(requestData)
    })
    .then(response => {
        if (!response.ok) {
            return response.text().then(text => {
                throw new Error(`API request failed: ${response.status} - ${text}`);
            });
        }
        return response.blob();
    })
    .then(blob => {
        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);
        
        preloadedAudios.push({
            index: index,
            segment: segment,
            audio: audio,
            url: audioUrl
        });
        
        console.log(`Successfully preloaded TTS segment ${index+1}/${ttsQueue.length}`);
        
        loadingSegments.delete(index);
        
        preloadTtsSegments();
    })
    .catch(error => {
        console.error(`Error preloading TTS segment ${index+1}:`, error);
        loadingSegments.delete(index);
    });
}

function getBase64AudioData(dataUrl) {
    // Uploaded samples are stored as data URLs (see onVoiceFileChange).
    // The API wants the payload without the data prefix, so I cut at the
    // first comma. A value with no prefix is assumed to be raw base64
    // already and passes through as it is.
    if (dataUrl.startsWith('data:')) {
        return dataUrl.split(',')[1];
    }
    return dataUrl;
}

function mapEmotionsToZyphraFormat(ttsEmotions) {
    if (!ttsEmotions || Object.keys(ttsEmotions).length === 0) {
        return {};
    }
    
    const zyphraEmotions = {};
    
    // These e1 to e8 codes are the same ones the instruction template
    // tells the model to emit. The template, this map, and
    // formatEmotions each carry their own copy of the list, so adding
    // an emotion means editing three places or the copies drift.
    const emotionMap = {
        'e1': 'happiness',
        'e2': 'sadness',
        'e3': 'disgust',
        'e4': 'fear',
        'e5': 'surprise',
        'e6': 'anger',
        'e7': 'other',
        'e8': 'neutral'
    };
    
    for (const [code, value] of Object.entries(ttsEmotions)) {
        const zyphraEmotion = emotionMap[code];
        if (zyphraEmotion) {
            zyphraEmotions[zyphraEmotion] = parseFloat(value);
        }
    }
    
    return zyphraEmotions;
}

// A swipe, an edit, or a delete makes any queued audio wrong, because
// the text it was built from no longer exists in that form. I reset on
// all three instead of trying to patch the queue.
eventSource.on(event_types.MESSAGE_SWIPED, () => resetTtsQueue(true));
eventSource.on(event_types.MESSAGE_EDITED, () => resetTtsQueue(true));
eventSource.on(event_types.MESSAGE_DELETED, () => resetTtsQueue(true));
// I register both spellings of the chat loaded event. Which constant a
// host version exposes differs, and a double reset on load costs
// nothing because resetExtensionState only clears state.
eventSource.on(event_types.CHAT_LOADED, () => resetExtensionState());
eventSource.on(event_types.chatLoaded, () => resetExtensionState());

// Nothing in this file calls outputFormattedParagraph either. It is a
// console pretty printer for parsed segments, from before playback
// worked. I keep it because reading its output is still how I eyeball
// what the parser did to a paragraph.
function outputFormattedParagraph(text, markers) {
    if (!markers || markers.length === 0) {
        console.log(`Unknown type: ${text.trim()}`);
        console.log('');
        return;
    }
    
    markers.sort((a, b) => a.position - b.position);
    
    let segments = [];
    let lastEnd = 0;
    let cleanText = text;
    
    function sanitizeText(text) {
        text = text.replace(/[\*\"]/g, '');
        text = text.replace(/\s+/g, ' ');
        text = text.replace(/[^a-zA-Z0-9\s.,!?'()-]/g, '');
        return text.trim();
    }
    
    markers.forEach((marker, index) => {
        let endPos = index < markers.length - 1 ? markers[index + 1].position : text.length;
        let segmentText = text.substring(marker.position + marker.fullMatch.length, endPos);
        
        segments.push({
            type: marker.type,
            character: marker.character,
            voiceFile: marker.voiceFile,
            emotions: marker.emotions,
            text: sanitizeText(segmentText)
        });
    });
    
    segments.forEach((segment, index) => {
        if (segment.type === 'a') {
            console.log(`Action: ${segment.text}`);
        } else if (segment.type === 'c') {
            let emotionsStr = formatEmotions(segment.emotions);
            if (index > 0 && segments[index - 1].type === 'a' && segment.text.startsWith('—')) {
                console.log(`${segment.character} (${segment.voiceFile}, ${emotionsStr}): "${segment.text}"`);
            } else {
                console.log(`${segment.character} (${segment.voiceFile}, ${emotionsStr}): "${segment.text}"`);
            }
        } else if (segment.type === 'n') {
            let emotionsStr = formatEmotions(segment.emotions);
            console.log(`Narrator (${segment.voiceFile}, ${emotionsStr}): ${segment.text}`);
        }
    });
    
    console.log('');
}

function formatEmotions(emotions) {
    if (!emotions || Object.keys(emotions).length === 0) {
        return "no emotions";
    }
    
    return Object.entries(emotions).map(([key, value]) => {
        let emotionName = key;
        switch (key) {
            case 'e1': emotionName = 'Happiness'; break;
            case 'e2': emotionName = 'Sadness'; break;
            case 'e3': emotionName = 'Disgust'; break;
            case 'e4': emotionName = 'Fear'; break;
            case 'e5': emotionName = 'Surprise'; break;
            case 'e6': emotionName = 'Anger'; break;
            case 'e7': emotionName = 'Other'; break;
            case 'e8': emotionName = 'Neutral'; break;
        }
        return `${emotionName}: ${value}`;
    }).join(', ');
}

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, injectInstructions);
eventSource.on(event_types.STREAM_TOKEN_RECEIVED, installStreamHook);

eventSource.on(event_types.GENERATION_STARTED, () => {
    console.log("Generation started, resetting state");
    instructionsInjected = false;
    uninstallStreamHook();
});

eventSource.on(event_types.GENERATION_STOPPED, () => {
    console.log("Generation stopped, resetting injection state");
    instructionsInjected = false;
});

async function customCallPopup(message, type) {
    if (type === 'input') {
        return prompt(message);
    } else if (type === 'confirm') {
        return confirm(message);
    }
    return false;
}

const popupFunction = getContext().callPopup || customCallPopup;

 
async function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    
    // I copy the defaults in only when the object is entirely empty. A
    // settings object holding one stale key blocks every other default,
    // and the form reads further down paper over the gaps with ||
    // fallbacks, which also means a stored empty string or zero can
    // never be read back as itself.
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }

    if (!extension_settings[extensionName].voices) {
        extension_settings[extensionName].voices = {
            narrator: {
                name: "Narrator",
                audioFiles: {
                    default: {
                        file: null,
                        fileName: null,
                        duration: null
                    }
                }
            }
        };
    } else if (!extension_settings[extensionName].voices.narrator) {
        extension_settings[extensionName].voices.narrator = {
            name: "Narrator",
            audioFiles: {
                default: {
                    file: null,
                    fileName: null,
                    duration: null
                }
            }
        };
    }

    // Settings saved before presets existed have no presets key, and
    // the defaults above only land on a fully empty object, so I seed
    // the Default preset here as well. The preset handlers below push
    // and splice this array and assume it exists.
    if (!extension_settings[extensionName].presets) {
        extension_settings[extensionName].presets = [{ ...defaultSettings.presets[0] }];
        extension_settings[extensionName].active_preset = "Default";
    }

    $("#TTSSorcery_enabled").prop("checked", extension_settings[extensionName].enabled || false);
    $("#TTSSorcery_api_key").val(extension_settings[extensionName].api_key || "");
    $("#TTSSorcery_model").val(extension_settings[extensionName].model || "zonos-v0.1-hybrid");
    $("#TTSSorcery_language_iso_code").val(extension_settings[extensionName].language_iso_code || "en-us");
    $("#TTSSorcery_speaking_rate").val(extension_settings[extensionName].speaking_rate || 15);
    $("#TTSSorcery_speaking_rate_value").val(extension_settings[extensionName].speaking_rate || 15);
    $("#TTSSorcery_vqscore").val(extension_settings[extensionName].vqscore || 0.78);
    $("#TTSSorcery_vqscore_value").val(extension_settings[extensionName].vqscore || 0.78);
    $("#TTSSorcery_speaker_noised").prop("checked", extension_settings[extensionName].speaker_noised || false);
    $("#TTSSorcery_disable_narrator").prop("checked", extension_settings[extensionName].disable_narrator || false);
    $("#TTSSorcery_action_handling").val(extension_settings[extensionName].action_handling || "narrator");
    $("#TTSSorcery_force_neutral_narrator").prop("checked", extension_settings[extensionName].force_neutral_narrator);
    
    updateHybridSettings();

    loadVoices();

    $("#TTSSorcery_max_preload").val(extension_settings[extensionName].max_preload || 5);
    $("#TTSSorcery_max_preload_value").val(extension_settings[extensionName].max_preload || 5);

    $("#TTSSorcery_segment_gap").val(extension_settings[extensionName].segment_gap || 0.5);
    $("#TTSSorcery_segment_gap_value").val(extension_settings[extensionName].segment_gap || 0.5);

    $("#TTSSorcery_auto_generation").prop("checked", extension_settings[extensionName].auto_generation);

    refreshPresetList();
}

function updateHybridSettings() {
    const isHybrid = $("#TTSSorcery_model").val() === "zonos-v0.1-hybrid";
    $(".hybrid-only").toggle(isHybrid);
}

function loadVoices() {
    $("#TTSSorcery_voices_list").empty();
    
    if (!extension_settings[extensionName].voices) {
        extension_settings[extensionName].voices = {
            narrator: {
                name: "Narrator",
                audioFiles: {
                    default: {
                        file: null,
                        fileName: null,
                        duration: null
                    }
                }
            }
        };
    }
    
    updateNarratorAudioFiles();
    
    for (const [voiceId, voice] of Object.entries(extension_settings[extensionName].voices)) {
        if (voiceId !== 'narrator') {
            addVoiceToUI(voiceId, voice);
        }
    }
}

function updateNarratorAudioFiles() {
    const narrator = extension_settings[extensionName].voices.narrator;
    if (!narrator || !narrator.audioFiles) return;
    
    console.log("Updating narrator audio files display");
    
    const narratorElement = $('[data-voice-id="narrator"]');
    const audioFilesContainer = narratorElement.find('.TTSSorcery-audio-files');
    
    audioFilesContainer.children().not('[data-audio-name="default"]').remove();
    
    const defaultAudio = narrator.audioFiles.default;
    if (defaultAudio) {
        const defaultFileInfo = narratorElement.find('[data-audio-name="default"] .TTSSorcery-file-info');
        if (defaultAudio.file) {
            defaultFileInfo.html(`
                <span class="TTSSorcery-file-name">File: ${defaultAudio.fileName || 'audio file'} ${defaultAudio.duration ? `(${formatDuration(defaultAudio.duration)})` : ''}</span>
                <button class="menu_button TTSSorcery-play-audio" data-voice-id="narrator" data-audio-name="default">
                    <i class="fa-solid fa-play"></i> Play
                </button>
            `);
        } else {
            defaultFileInfo.html('<span class="TTSSorcery-file-name">No file uploaded</span>');
        }
    }
    
    Object.entries(narrator.audioFiles)
        .filter(([name]) => name !== 'default')
        .forEach(([name, audio]) => {
            console.log(`Adding variant: ${name}`, audio);
            
            const variantHtml = `
                <div class="TTSSorcery-audio-file" data-audio-name="${name}">
                    <div class="flex-container">
                        <input type="text" class="text_pole flex1 TTSSorcery-audio-name" value="${name}" placeholder="Audio variant name">
                        <div class="flex-container">
                            <input type="file" id="TTSSorcery_file_upload_narrator_${name.replace(/\s+/g, '_')}" class="TTSSorcery-voice-file-input" accept="audio/webm,audio/ogg,audio/wav,audio/mp3,audio/mpeg,audio/mp4,audio/aac" style="display:none;">
                            <label for="TTSSorcery_file_upload_narrator_${name.replace(/\s+/g, '_')}" class="menu_button">Import Audio</label>
                            <div class="menu_button TTSSorcery-delete-audio"><i class="fa-solid fa-trash-can"></i></div>
                        </div>
                    </div>
                    <div class="TTSSorcery-file-info">
                        ${audio.file ? 
                            `<span class="TTSSorcery-file-name">File: ${audio.fileName || 'audio file'} ${audio.duration ? `(${formatDuration(audio.duration)})` : ''}</span>
                             <button class="menu_button TTSSorcery-play-audio" data-voice-id="narrator" data-audio-name="${name}">
                                <i class="fa-solid fa-play"></i> Play
                             </button>` : 
                            '<span class="TTSSorcery-file-name">No file uploaded</span>'
                        }
                    </div>
                    <div class="TTSSorcery-tips">
                        <div class="TTSSorcery-tips-toggle"><i class="fa-solid fa-circle-info"></i> Tips for best results</div>
                        <div class="TTSSorcery-tips-content" style="display: none;">
                            <ul>
                                <li>Ideal sample length: 10-30 seconds</li>
                                <li>Avoid background noise in recordings</li>
                                <li>Supported formats: WebM, OGG, WAV, MP3, MP4/AAC</li>
                                <li>Supported languages: English, Japanese, Chinese, French, German, Korean</li>
                            </ul>
                        </div>
                    </div>
                    <hr class="sysHR">
                </div>
            `;
            audioFilesContainer.append(variantHtml);
        });
}

function switchTab(tabName) {
    $('.tab-button').removeClass('active');
    $('.tab-content').hide();
    $(`.tab-button[data-tab="${tabName}"]`).addClass('active');
    $(`.tab-content[data-tab="${tabName}"]`).show();
}

function addVoiceToUI(voiceId, voice) {
    // The narrator never goes through this template in practice. It is
    // built by hand in the settings HTML, and the rename and delete
    // handlers refuse to touch it, because every fallback path in
    // playback lands on the narrator voice. Other voices get a name
    // field and a delete button here. The narrator branch of this
    // template exists only so the function does not break if it is ever
    // called with that id.
    const isNarrator = voiceId === 'narrator';
    const voiceItem = `
        <div class="TTSSorcery-voice-item" data-voice-id="${voiceId}">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    ${isNarrator ? 
                        `<b class="TTSSorcery-voice-name">Narrator</b>` : 
                        `<input type="text" class="text_pole flex1 TTSSorcery-voice-name" value="${voice.name}" placeholder="Character Name">`
                    }
                    ${isNarrator ? '' : '<div class="menu_button TTSSorcery-delete-voice"><i class="fa-solid fa-trash-can"></i></div>'}
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="TTSSorcery-audio-files">
                        <div class="TTSSorcery-audio-file" data-audio-name="default">
                            <div class="flex-container">
                                <b class="flex1">Default Audio:</b>
                                <div class="flex-container">
                                    <input type="file" id="TTSSorcery_file_upload_${voiceId}_default" class="TTSSorcery-voice-file-input" accept="audio/webm,audio/ogg,audio/wav,audio/mp3,audio/mpeg,audio/mp4,audio/aac" style="display:none;">
                                    <label for="TTSSorcery_file_upload_${voiceId}_default" class="menu_button">Import Audio</label>
                                </div>
                            </div>
                            <div class="TTSSorcery-file-info">
                                ${voice.audioFiles.default.file ? 
                                    `<span class="TTSSorcery-file-name">File: ${voice.audioFiles.default.fileName || 'audio file'} ${voice.audioFiles.default.duration ? `(${formatDuration(voice.audioFiles.default.duration)})` : ''}</span>
                                     <button class="menu_button TTSSorcery-play-audio" data-voice-id="${voiceId}" data-audio-name="default"><i class="fa-solid fa-play"></i> Play</button>` : 
                                    '<span class="TTSSorcery-file-name">No file uploaded</span>'
                                }
                            </div>
                            <div class="TTSSorcery-tips">
                                <div class="TTSSorcery-tips-toggle"><i class="fa-solid fa-circle-info"></i> Tips for best results</div>
                                <div class="TTSSorcery-tips-content" style="display: none;">
                                    <ul>
                                        <li>Ideal sample length: 10-30 seconds</li>
                                        <li>Avoid background noise in recordings</li>
                                        <li>Supported formats: WebM, OGG, WAV, MP3, MP4/AAC</li>
                                        <li>Supported languages: English, Japanese, Chinese, French, German, Korean</li>
                                    </ul>
                                </div>
                            </div>
                            <hr class="sysHR">
                        </div>
                        
                        ${Object.entries(voice.audioFiles)
                            .filter(([name]) => name !== 'default')
                            .map(([name, audio]) => `
                                <div class="TTSSorcery-audio-file" data-audio-name="${name}">
                                    <div class="flex-container">
                                        <input type="text" class="text_pole flex1 TTSSorcery-audio-name" value="${name}" placeholder="Audio variant name">
                                        <div class="flex-container">
                                            <input type="file" id="TTSSorcery_file_upload_${voiceId}_${name.replace(/\s+/g, '_')}" class="TTSSorcery-voice-file-input" accept="audio/webm,audio/ogg,audio/wav,audio/mp3,audio/mpeg,audio/mp4,audio/aac" style="display:none;">
                                            <label for="TTSSorcery_file_upload_${voiceId}_${name.replace(/\s+/g, '_')}" class="menu_button">Import Audio</label>
                                            <div class="menu_button TTSSorcery-delete-audio"><i class="fa-solid fa-trash-can"></i></div>
                                        </div>
                                    </div>
                                    <div class="TTSSorcery-file-info">
                                        ${audio.file ? 
                                            `<span class="TTSSorcery-file-name">File: ${audio.fileName || 'audio file'} ${audio.duration ? `(${formatDuration(audio.duration)})` : ''}</span>
                                             <button class="menu_button TTSSorcery-play-audio" data-voice-id="${voiceId}" data-audio-name="${name}"><i class="fa-solid fa-play"></i> Play</button>` : 
                                            '<span class="TTSSorcery-file-name">No file uploaded</span>'
                                        }
                                    </div>
                                    <div class="TTSSorcery-tips">
                                        <div class="TTSSorcery-tips-toggle"><i class="fa-solid fa-circle-info"></i> Tips for best results</div>
                                        <div class="TTSSorcery-tips-content" style="display: none;">
                                            <ul>
                                                <li>Ideal sample length: 10-30 seconds</li>
                                                <li>Avoid background noise in recordings</li>
                                                <li>Supported formats: WebM, OGG, WAV, MP3, MP4/AAC</li>
                                                <li>Supported languages: English, Japanese, Chinese, French, German, Korean</li>
                                            </ul>
                                        </div>
                                    </div>
                                    <hr class="sysHR">
                                </div>
                            `).join('')}
                    </div>
                    <div class="flex-container">
                        <input type="button" class="menu_button TTSSorcery-add-audio" value="Add Audio Variant">
                    </div>
                </div>
            </div>
        </div>
    `;
    
    $("#TTSSorcery_voices_list").append(voiceItem);
}

function onAddVoice() {
    const voiceId = Date.now().toString();
    const newVoice = {
        name: "New Character",
        audioFiles: {
            default: {
                file: null,
                fileName: null,
                duration: null
            }
        }
    };
    
    extension_settings[extensionName].voices[voiceId] = newVoice;
    
    addVoiceToUI(voiceId, newVoice);
    saveSettingsDebounced();
}

function addAudioVariant(voiceItem) {
    const voiceId = voiceItem.data('voice-id');
    const newAudioName = "New Variant";
    const audioFile = {
        file: null,
        fileName: null,
        duration: null
    };
    
    if (!extension_settings[extensionName].voices) {
        extension_settings[extensionName].voices = {};
    }
    
    if (!extension_settings[extensionName].voices[voiceId]) {
        extension_settings[extensionName].voices[voiceId] = {
            name: voiceId === 'narrator' ? 'Narrator' : 'New Character',
            audioFiles: {}
        };
    }
    
    if (!extension_settings[extensionName].voices[voiceId].audioFiles) {
        extension_settings[extensionName].voices[voiceId].audioFiles = {};
    }
    
    extension_settings[extensionName].voices[voiceId].audioFiles[newAudioName] = audioFile;
    
    if (voiceId === 'narrator') {
        updateNarratorAudioFiles();
    } else {
        const uniqueId = `TTSSorcery_file_upload_${voiceId}_${newAudioName.replace(/\s+/g, '_')}`;
        const newAudioElement = `
            <div class="TTSSorcery-audio-file" data-audio-name="${newAudioName}">
                <div class="flex-container">
                    <input type="text" class="text_pole flex1 TTSSorcery-audio-name" value="${newAudioName}" placeholder="Audio variant name">
                    <div class="flex-container">
                        <input type="file" id="${uniqueId}" class="TTSSorcery-voice-file-input" accept="audio/webm,audio/ogg,audio/wav,audio/mp3,audio/mpeg,audio/mp4,audio/aac" style="display:none;">
                        <label for="${uniqueId}" class="menu_button">Import Audio</label>
                        <div class="menu_button TTSSorcery-delete-audio"><i class="fa-solid fa-trash-can"></i></div>
                    </div>
                </div>
                <div class="TTSSorcery-file-info">
                    <span class="TTSSorcery-file-name">No file uploaded</span>
                </div>
                <div class="TTSSorcery-tips">
                    <div class="TTSSorcery-tips-toggle"><i class="fa-solid fa-circle-info"></i> Tips for best results</div>
                    <div class="TTSSorcery-tips-content" style="display: none;">
                        <ul>
                            <li>Ideal sample length: 10-30 seconds</li>
                            <li>Avoid background noise in recordings</li>
                            <li>Supported formats: WebM, OGG, WAV, MP3, MP4/AAC</li>
                            <li>Supported languages: English, Japanese, Chinese, French, German, Korean</li>
                        </ul>
                    </div>
                </div>
            </div>
        `;
        voiceItem.find('.TTSSorcery-audio-files').append(newAudioElement);
    }
    
    saveSettingsDebounced();
}

function onAudioNameChange(event) {
    const audioFile = $(event.target).closest('.TTSSorcery-audio-file');
    const voiceItem = audioFile.closest('.TTSSorcery-voice-item');
    const voiceId = voiceItem.data('voice-id');
    const oldName = audioFile.data('audio-name');
    const newName = $(event.target).val().trim();
    
    console.log(`Attempting to rename variant from "${oldName}" to "${newName}"`);
    
    if (!newName) {
        toastr.error('Variant name cannot be empty');
        $(event.target).val(oldName);
        return;
    }
    
    if (oldName === 'default') {
        toastr.error('Cannot rename default audio');
        $(event.target).val('default');
        return;
    }
    
    if (extension_settings[extensionName].voices[voiceId].audioFiles[newName] && newName !== oldName) {
        toastr.error('A variant with this name already exists');
        $(event.target).val(oldName);
        return;
    }
    
    const voice = extension_settings[extensionName].voices[voiceId];
    voice.audioFiles[newName] = {...voice.audioFiles[oldName]};
    delete voice.audioFiles[oldName];
    
    audioFile.attr('data-audio-name', newName);
    
    const fileInput = audioFile.find('.TTSSorcery-voice-file-input');
    const newId = `TTSSorcery_file_upload_${voiceId}_${newName.replace(/\s+/g, '_')}`;
    fileInput.attr('id', newId);
    fileInput.siblings('label').attr('for', newId);
    
    $(event.target).closest('.TTSSorcery-audio-file').data('audio-name', newName);
    
    saveSettingsDebounced();
    console.log(`Successfully renamed variant from "${oldName}" to "${newName}"`);
}

function onDeleteAudio(event) {
    const audioFile = $(event.target).closest('.TTSSorcery-audio-file');
    const voiceItem = audioFile.closest('.TTSSorcery-voice-item');
    const voiceId = voiceItem.data('voice-id');
    const audioName = audioFile.data('audio-name');
    
    if (audioName === 'default') {
        toastr.error('Cannot delete default audio');
        return;
    }
    
    delete extension_settings[extensionName].voices[voiceId].audioFiles[audioName];
    
    audioFile.remove();
    saveSettingsDebounced();
}

function onVoiceNameChange(event) {
    const voiceItem = $(event.target).closest('.TTSSorcery-voice-item');
    const voiceId = voiceItem.data('voice-id');
    
    if (voiceId === 'narrator') {
        toastr.error('Cannot rename Narrator');
        $(event.target).val('Narrator');
        return;
    }
    
    const newName = $(event.target).val();
    extension_settings[extensionName].voices[voiceId].name = newName;
    saveSettingsDebounced();
}

function onVoiceFileChange(event) {
    const file = event.target.files[0];
    if (!file) {
        console.log("No file selected");
        return;
    }
    
    const supportedTypes = [
        'audio/webm',
        'audio/ogg',
        'audio/wav',
        'audio/mp3',
        'audio/mpeg',
        'audio/mp4',
        'audio/aac'
    ];
    
    if (!supportedTypes.includes(file.type)) {
        console.error("Unsupported file type:", file.type);
        toastr.error('Unsupported audio format. Please use WebM, OGG, WAV, MP3, or MP4/AAC.');
        return;
    }
    
    console.log("File selected:", file.name, "Type:", file.type);
    
    const fileInput = $(event.target);
    const audioFile = fileInput.closest('.TTSSorcery-audio-file');
    const voiceItem = audioFile.closest('.TTSSorcery-voice-item');
    const voiceId = voiceItem.data('voice-id');
    const audioName = audioFile.data('audio-name');
    
    console.log("Voice ID:", voiceId, "Audio Name:", audioName);
    
    if (!extension_settings[extensionName].voices) {
        console.log("Creating voices object");
        extension_settings[extensionName].voices = {};
    }
    
    if (!extension_settings[extensionName].voices[voiceId]) {
        console.log("Creating voice:", voiceId);
        extension_settings[extensionName].voices[voiceId] = {
            name: voiceId === 'narrator' ? 'Narrator' : 'New Character',
            audioFiles: {}
        };
    }
    
    // I load the file into an Audio element first only to learn its
    // duration. The bytes are read after loadedmetadata fires, so a
    // file the browser cannot decode never reaches the settings object.
    // What does reach it is a base64 data URL, and SillyTavern saves
    // settings as JSON, so a long sample makes a large settings file.
    // That is the cost of having no server side storage in this design.
    const audio = new Audio(URL.createObjectURL(file));
    
    console.log("Created audio element");
    
    audio.addEventListener('loadedmetadata', function() {
        const duration = audio.duration;
        console.log("Audio duration:", duration);
        
        const reader = new FileReader();
        reader.onload = function(e) {
            console.log("File loaded to base64");
            
            extension_settings[extensionName].voices[voiceId].audioFiles[audioName] = {
                file: e.target.result,
                fileName: file.name,
                duration: duration
            };
            
            const fileInfoHtml = `
                <span class="TTSSorcery-file-name">File: ${file.name} (${formatDuration(duration)})</span>
                <button class="menu_button TTSSorcery-play-audio" data-voice-id="${voiceId}" data-audio-name="${audioName}">
                    <i class="fa-solid fa-play"></i> Play
                </button>
            `;
            audioFile.find('.TTSSorcery-file-info').html(fileInfoHtml);
            
            console.log("UI updated");
            
            saveSettingsDebounced();
        };
        
        reader.onerror = function(error) {
            console.error("Error reading file:", error);
            toastr.error("Failed to read audio file");
        };
        
        reader.readAsDataURL(file);
    });
    
    audio.addEventListener('error', function(e) {
        console.error("Error loading audio:", e);
        toastr.error("Failed to load audio file. The file may be corrupt or in an unsupported format.");
    });
}

function onDeleteVoice(event) {
    const voiceItem = $(event.target).closest('.TTSSorcery-voice-item');
    const voiceId = voiceItem.data('voice-id');
    
    if (voiceId === 'narrator') {
        toastr.error('Cannot delete the Narrator');
        return;
    }
    
    delete extension_settings[extensionName].voices[voiceId];
    voiceItem.remove();
    saveSettingsDebounced();
}
function onEnabledInput(event) {
    const isEnabled = $(event.target).prop('checked');
    extension_settings[extensionName].enabled = isEnabled;
    
    if (!isEnabled) {
        uninstallStreamHook();
    }
    
    saveSettingsDebounced();
}

function onModelChoiceInput(event) {
    extension_settings[extensionName].model = $(event.target).val();
    updateCurrentPreset();
    saveSettingsDebounced();
}

function onLanguageInput(event) {
    extension_settings[extensionName].language_iso_code = $(event.target).val();
    updateCurrentPreset();
    saveSettingsDebounced();
}

function onAutoGenerationInput(event) {
    const isEnabled = $(event.target).prop('checked');
    extension_settings[extensionName].auto_generation = isEnabled;
    saveSettingsDebounced();
}

function onSliderInput(event) {
    const id = $(event.target).attr('id');
    const value = parseFloat($(event.target).val());
    const settingKey = id.replace('TTSSorcery_', '');
    
    $(`#${id}_value`).val(value);
    
    extension_settings[extensionName][settingKey] = value;
    updateCurrentPreset();
    saveSettingsDebounced();
}

function onCounterInput(event) {
    const id = $(event.target).attr('id').replace('_value', '');
    const value = parseFloat($(event.target).val());
    
    $(`#${id}`).val(value);
    
    const settingKey = id.replace('TTSSorcery_', '');
    extension_settings[extensionName][settingKey] = value;
    updateCurrentPreset();
    saveSettingsDebounced();
}

function refreshPresetList() {
    // defaultSettings carries a Default preset, and the fallback below
    // copies it (a copy, not the shared object, so editing the active
    // preset never rewrites the defaults) the first time this runs with
    // no stored presets.
    if (!extension_settings[extensionName].presets) {
        extension_settings[extensionName].presets = [{ ...defaultSettings.presets[0] }];
    }
    
    const presetNames = extension_settings[extensionName].presets.map(p => p.name);
    const $presetList = $('#TTSSorcery_preset_list').empty();
    presetNames.forEach(name => {
        $presetList.append($('<option>', { value: name, text: name }));
    });
    
    if (!extension_settings[extensionName].active_preset || 
        !presetNames.includes(extension_settings[extensionName].active_preset)) {
        extension_settings[extensionName].active_preset = "Default";
    }
    
    $presetList.val(extension_settings[extensionName].active_preset);
}

function getCurrentPreset() {
    if (!extension_settings[extensionName].presets || !extension_settings[extensionName].active_preset) {
        return null;
    }
    
    return extension_settings[extensionName].presets.find(p => 
        p.name === extension_settings[extensionName].active_preset);
}

function updateCurrentPreset() {
    const currentPreset = getCurrentPreset();
    if (!currentPreset) return;

    currentPreset.model = extension_settings[extensionName].model;
    currentPreset.language_iso_code = extension_settings[extensionName].language_iso_code;
    currentPreset.speaking_rate = extension_settings[extensionName].speaking_rate;
    currentPreset.vqscore = extension_settings[extensionName].vqscore;
    currentPreset.speaker_noised = extension_settings[extensionName].speaker_noised;
}

function loadPreset(presetName) {
    const preset = extension_settings[extensionName].presets.find(p => p.name === presetName);
    if (!preset) return;

    extension_settings[extensionName].active_preset = presetName;
    extension_settings[extensionName].model = preset.model;
    extension_settings[extensionName].language_iso_code = preset.language_iso_code;
    extension_settings[extensionName].speaking_rate = preset.speaking_rate;
    extension_settings[extensionName].vqscore = preset.vqscore;
    extension_settings[extensionName].speaker_noised = preset.speaker_noised;

    $("#TTSSorcery_model").val(preset.model);
    $("#TTSSorcery_language_iso_code").val(preset.language_iso_code);
    $("#TTSSorcery_speaking_rate").val(preset.speaking_rate);
    $("#TTSSorcery_speaking_rate_value").val(preset.speaking_rate);
    $("#TTSSorcery_vqscore").val(preset.vqscore);
    $("#TTSSorcery_vqscore_value").val(preset.vqscore);
    $("#TTSSorcery_speaker_noised").prop("checked", preset.speaker_noised);

  saveSettingsDebounced();
}

let currentlyPlayingAudio = null;

function playAudio(voiceId, audioName) {
    const audioData = extension_settings[extensionName].voices[voiceId]?.audioFiles[audioName]?.file;
    if (!audioData) {
        toastr.error('No audio file available to play');
        return;
    }
    
    if (currentlyPlayingAudio) {
        currentlyPlayingAudio.pause();
        currentlyPlayingAudio.currentTime = 0;
    }
    
    const audio = new Audio(audioData);
    currentlyPlayingAudio = audio;
    
    $(`.TTSSorcery-play-audio[data-voice-id="${voiceId}"][data-audio-name="${audioName}"]`)
        .html('<i class="fa-solid fa-stop"></i> Stop');
    
    audio.onended = function() {
        currentlyPlayingAudio = null;
        $(`.TTSSorcery-play-audio[data-voice-id="${voiceId}"][data-audio-name="${audioName}"]`)
            .html('<i class="fa-solid fa-play"></i> Play');
    };
    
    audio.play().catch(error => {
        console.error('Error playing audio:', error);
        toastr.error('Failed to play audio file');
        currentlyPlayingAudio = null;
        $(`.TTSSorcery-play-audio[data-voice-id="${voiceId}"][data-audio-name="${audioName}"]`)
            .html('<i class="fa-solid fa-play"></i> Play');
    });
}

function stopAudio() {
    if (currentlyPlayingAudio) {
        currentlyPlayingAudio.pause();
        currentlyPlayingAudio.currentTime = 0;
        currentlyPlayingAudio = null;
        
        $('.TTSSorcery-play-audio').html('<i class="fa-solid fa-play"></i> Play');
    }
}

function setupEventHandlers() {
    $('.tab-button').on('click', function() {
        switchTab($(this).data('tab'));
    });

    $('#TTSSorcery_api_key').on('input', function() {
        extension_settings[extensionName].api_key = $(this).val();
        saveSettingsDebounced();
    });

    $('#TTSSorcery_preset_list').on('change', function() {
        loadPreset($(this).val());
    });

    $('#TTSSorcery_preset_new').on('click', async function() {
        const newPresetName = await popupFunction('Enter new preset name:', 'input');
        if (!newPresetName) return;

        const newPreset = {
            name: newPresetName,
            model: extension_settings[extensionName].model,
            language_iso_code: extension_settings[extensionName].language_iso_code,
            speaking_rate: extension_settings[extensionName].speaking_rate,
            vqscore: extension_settings[extensionName].vqscore,
            speaker_noised: extension_settings[extensionName].speaker_noised
        };

        extension_settings[extensionName].presets.push(newPreset);
        extension_settings[extensionName].active_preset = newPresetName;
        refreshPresetList();
        saveSettingsDebounced();
    });

    $('#TTSSorcery_preset_import').on('click', function() {
        $('#TTSSorcery_preset_import_file').click();
    });

    $('#TTSSorcery_preset_import_file').on('change', async function() {
        const file = this.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const preset = JSON.parse(text);
            extension_settings[extensionName].presets.push(preset);
            extension_settings[extensionName].active_preset = preset.name;
            refreshPresetList();
            loadPreset(preset.name);
            toastr.success('Preset imported successfully');
        } catch (error) {
            console.error(error);
            toastr.error('Failed to import preset');
        }
        this.value = '';
    });

    $('#TTSSorcery_preset_export').on('click', function() {
        updateCurrentPreset();
        
        const preset = getCurrentPreset();
        if (!preset) return;

        const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${preset.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_preset.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    $('#TTSSorcery_preset_delete').on('click', async function() {
        const preset = getCurrentPreset();
        if (!preset || preset.name === 'Default') {
            toastr.error('Cannot delete default preset');
            return;
        }

        if (!await popupFunction('Are you sure you want to delete this preset?', 'confirm')) return;

        const index = extension_settings[extensionName].presets.findIndex(p => p.name === preset.name);
        extension_settings[extensionName].presets.splice(index, 1);
        extension_settings[extensionName].active_preset = 'Default';
        refreshPresetList();
        loadPreset('Default');
        saveSettingsDebounced();
    });

    $("#TTSSorcery_add_voice").on("click", onAddVoice);
    
    $(document).on("input", ".TTSSorcery-voice-name", onVoiceNameChange);
    $(document).on("input", ".TTSSorcery-audio-name", onAudioNameChange);
    $(document).on("change", ".TTSSorcery-voice-file-input", onVoiceFileChange);
    $(document).on("click", ".TTSSorcery-delete-voice", onDeleteVoice);
    $(document).on("click", ".TTSSorcery-delete-audio", onDeleteAudio);
    $(document).on("click", ".TTSSorcery-add-audio", function() {
      const voiceItem = $(this).closest('.TTSSorcery-voice-item');
      addAudioVariant(voiceItem);
    });
    $(document).on("click", ".TTSSorcery-play-audio", function() {
      const voiceId = $(this).data('voice-id');
      const audioName = $(this).data('audio-name');
      
      const isPlaying = currentlyPlayingAudio && 
                       $(this).html().includes('Stop');
      
      stopAudio();
      
      if (!isPlaying) {
          playAudio(voiceId, audioName);
      }
  });

    $("#TTSSorcery_speaker_noised").on("change", function() {
        extension_settings[extensionName].speaker_noised = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $(document).on("click", ".TTSSorcery-tips-toggle", function() {
        $(this).siblings('.TTSSorcery-tips-content').slideToggle(200);
    });

    $("#TTSSorcery_model").on("change", function() {
        extension_settings[extensionName].model = $(this).val();
        updateHybridSettings();
        saveSettingsDebounced();
    });

    $("#TTSSorcery_language_iso_code").on("change", function() {
        extension_settings[extensionName].language_iso_code = $(this).val();
        saveSettingsDebounced();
    });

    $("#TTSSorcery_speaking_rate").on("input", function() {
        const value = parseFloat($(this).val());
        $("#TTSSorcery_speaking_rate_value").val(value);
        extension_settings[extensionName].speaking_rate = value;
        saveSettingsDebounced();
    });

    $("#TTSSorcery_speaking_rate_value").on("input", function() {
        const value = parseFloat($(this).val());
        $("#TTSSorcery_speaking_rate").val(value);
        extension_settings[extensionName].speaking_rate = value;
        saveSettingsDebounced();
    });

    $("#TTSSorcery_vqscore").on("input", function() {
        const value = parseFloat($(this).val());
        $("#TTSSorcery_vqscore_value").val(value);
        extension_settings[extensionName].vqscore = value;
        saveSettingsDebounced();
    });

    $("#TTSSorcery_vqscore_value").on("input", function() {
        const value = parseFloat($(this).val());
        $("#TTSSorcery_vqscore").val(value);
        extension_settings[extensionName].vqscore = value;
        saveSettingsDebounced();
    });

    $("#TTSSorcery_disable_narrator").on("change", function() {
        extension_settings[extensionName].disable_narrator = !!$(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#TTSSorcery_action_handling").on("change", function() {
        extension_settings[extensionName].action_handling = $(this).val();
        saveSettingsDebounced();
    });

    $("#TTSSorcery_max_preload").on("input", function() {
        const value = parseInt($(this).val());
        $("#TTSSorcery_max_preload_value").val(value);
        extension_settings[extensionName].max_preload = value;
        saveSettingsDebounced();
    });

    $("#TTSSorcery_max_preload_value").on("input", function() {
        const value = parseInt($(this).val());
        $("#TTSSorcery_max_preload").val(value);
        extension_settings[extensionName].max_preload = value;
        saveSettingsDebounced();
    });

    $("#TTSSorcery_segment_gap").on("input", function() {
        const value = parseFloat($(this).val());
        $("#TTSSorcery_segment_gap_value").val(value);
        extension_settings[extensionName].segment_gap = value;
        saveSettingsDebounced();
    });

    $("#TTSSorcery_segment_gap_value").on("input", function() {
        const value = parseFloat($(this).val());
        $("#TTSSorcery_segment_gap").val(value);
        extension_settings[extensionName].segment_gap = value;
        saveSettingsDebounced();
    });
}

function initializeVoiceDrawers() {
    $('.TTSSorcery-voice-item .inline-drawer-content').hide();
    $('.TTSSorcery-voice-item .inline-drawer-icon').removeClass('down');
    
    $('.tab-button').on('click', function() {
        if ($(this).data('tab') === 'voices') {
            $('.TTSSorcery-voice-item .inline-drawer-content').hide();
            $('.TTSSorcery-voice-item .inline-drawer-icon').removeClass('down');
        }
    });
}

jQuery(async () => {
    const settingsHtml = `<div class="TTSSorcery-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>TTSSorcery</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
           
            <div>
                <label class="checkbox_label" for="TTSSorcery_enabled">
                    <input type="checkbox" id="TTSSorcery_enabled">
                    <small>Enabled</small>
                </label>
            </div>
            
            
            <div>
                <label class="checkbox_label" for="TTSSorcery_auto_generation">
                    <input type="checkbox" id="TTSSorcery_auto_generation">
                    <small>Auto Generation (streaming only)</small>
                </label>
            </div>
            
            
            
            <div>
                <label class="checkbox_label" for="TTSSorcery_disable_narrator">
                    <input type="checkbox" id="TTSSorcery_disable_narrator">
                    <small>Disable "Narrator" character</small>
                </label>
            </div>
            
            <hr class="sysHR">
            
            
            <div class="TTSSorcery-tabs">
                <div class="tab-buttons">
                    <button class="tab-button menu_button" data-tab="api">API</button>
                    <button class="tab-button menu_button" data-tab="voices">Voices</button>
                    <button class="tab-button menu_button" data-tab="settings">Settings</button>
                </div>
                
                
                <div class="tab-content" data-tab="api">
                    <div class="flex-container flexFlowColumn">
                        <label for="TTSSorcery_api_key">Zyphra API Key (free) <a href="https://playground.zyphra.com/settings/api-keys" target="_blank"><i class="fa-solid fa-circle-info"></i></a></label>
                        <input id="TTSSorcery_api_key" type="password" class="text_pole">
                    </div>
                </div>
                
                
                <div class="tab-content" data-tab="voices">
                    
                    <div class="TTSSorcery-voice-item" data-voice-id="narrator">
                        <div class="inline-drawer">
                            <div class="inline-drawer-toggle inline-drawer-header">
                                <b class="TTSSorcery-voice-name">Narrator</b>
                                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
                            </div>
                            <div class="inline-drawer-content" style="display: none;">
                                <div class="TTSSorcery-audio-files">
                                    
                                    <div class="TTSSorcery-audio-file" data-audio-name="default">
                                        <div class="flex-container">
                                            <b class="flex1">Default Audio:</b>
                                            <div class="flex-container">
                                                <input type="file" 
                                                    id="TTSSorcery_file_upload_narrator_default" 
                                                    class="TTSSorcery-voice-file-input" 
                                                    accept="audio/webm,audio/ogg,audio/wav,audio/mp3,audio/mpeg,audio/mp4,audio/aac" 
                                                    style="display:none;">
                                                <label for="TTSSorcery_file_upload_narrator_default" class="menu_button">Import Audio</label>
                                            </div>
                                        </div>
                                        <div class="TTSSorcery-file-info">
                                            <span class="TTSSorcery-file-name">No file uploaded</span>
                                        </div>
                                        <div class="TTSSorcery-tips">
                                            <div class="TTSSorcery-tips-toggle"><i class="fa-solid fa-circle-info"></i> Tips for best results</div>
                                            <div class="TTSSorcery-tips-content" style="display: none;">
                                                <ul>
                                                    <li>Ideal sample length: 10-30 seconds</li>
                                                    <li>Avoid background noise in recordings</li>
                                                    <li>Supported languages: English, Japanese, Chinese, French, German, Korean</li>
                                                </ul>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div class="flex-container">
                                    <input type="button" class="menu_button TTSSorcery-add-audio" value="Add Audio Variant">
                                </div>
                            </div>
                        </div>
                    </div>

                    
                    <div id="TTSSorcery_voices_list">
                        
                    </div>
                    
                    <div class="flex-container">
                        <input id="TTSSorcery_add_voice" class="menu_button" type="button" value="Add New Character">
                    </div>
                </div>
                
                
                <div class="tab-content" data-tab="settings">
                    
                    <div class="flex-container flexFlowColumn">
                        <label for="TTSSorcery_model">Model Type</label>
                        <select id="TTSSorcery_model" class="text_pole">
                            <option value="zonos-v0.1-transformer">Transformer</option>
                            <option value="zonos-v0.1-hybrid">Hybrid</option>
                        </select>
                    </div>
                    
                    
                    <div class="flex-container flexFlowColumn">
                        <label for="TTSSorcery_language_iso_code">Language</label>
                        <select id="TTSSorcery_language_iso_code" class="text_pole">
                            <option value="en-us">English (US)</option>
                            <option value="fr-fr">French</option>
                            <option value="de">German</option>
                            <option value="ja">Japanese (recommended for hybrid model)</option>
                            <option value="ko">Korean</option>
                            <option value="cmn">Mandarin Chinese</option>
                        </select>
                    </div>
                    
                    
                    <div class="flex-container flexFlowColumn">
                        <label for="TTSSorcery_action_handling">"Action" event handling</label>
                        <select id="TTSSorcery_action_handling" class="text_pole">
                            <option value="narrator" selected>Narrator</option>
                            <option value="silence">Silence</option>
                        </select>
                    </div>
                    
                    
                    <div class="range-block">
                        <div class="range-block-title">
                            <small>Speaking Rate</small>
                        </div>
                        <div class="range-block-range-and-counter">
                            <div class="range-block-range">
                                <input type="range" id="TTSSorcery_speaking_rate" min="5" max="35" step="0.1" value="15">
                            </div>
                            <div class="range-block-counter">
                                <input type="number" min="5" max="35" step="0.1" id="TTSSorcery_speaking_rate_value" value="15">
                            </div>
                        </div>
                    </div>
                    
                    
                    <div class="range-block">
                        <div class="range-block-title">
                            <small>Maximum preloaded segments</small>
                        </div>
                        <div class="range-block-range-and-counter">
                            <div class="range-block-range">
                                <input type="range" id="TTSSorcery_max_preload" min="1" max="10" step="1" value="5">
                            </div>
                            <div class="range-block-counter">
                                <input type="number" min="1" max="10" id="TTSSorcery_max_preload_value" value="5">
                            </div>
                        </div>
                    </div>
                    
                    
                    <div class="range-block">
                        <div class="range-block-title">
                            <small>Gap between segments (seconds)</small>
                        </div>
                        <div class="range-block-range-and-counter">
                            <div class="range-block-range">
                                <input type="range" id="TTSSorcery_segment_gap" min="0" max="2" step="0.1" value="0.5">
                            </div>
                            <div class="range-block-counter">
                                <input type="number" min="0" max="2" step="0.1" id="TTSSorcery_segment_gap_value" value="0.5">
                            </div>
                        </div>
                    </div>
                    
                    
                    <div class="range-block hybrid-only" style="display: none;">
                        <div class="range-block-title">
                            <small>Voice Quality Score</small>
                        </div>
                        <div class="range-block-range-and-counter">
                            <div class="range-block-range">
                                <input type="range" id="TTSSorcery_vqscore" min="0.6" max="0.8" step="0.01" value="0.78">
                            </div>
                            <div class="range-block-counter">
                                <input type="number" min="0.6" max="0.8" step="0.01" id="TTSSorcery_vqscore_value" value="0.78">
                            </div>
                        </div>
                    </div>
                    
                    
                    <div class="hybrid-only" style="display: none;">
                        <label class="checkbox_label" for="TTSSorcery_speaker_noised">
                            <input type="checkbox" id="TTSSorcery_speaker_noised">
                            <small>Enable speaker denoising (may increase latency)</small>
                        </label>
                    </div>

                    <div>
                        <label class="checkbox_label" for="TTSSorcery_force_neutral_narrator">
                            <input type="checkbox" id="TTSSorcery_force_neutral_narrator">
                            <small>Force narrator to use neutral emotions</small>
                        </label>
                    </div>

                    <div class="flex-container flexFlowColumn">
                        <label for="TTSSorcery_preset_list">Settings preset</label>
                        <select id="TTSSorcery_preset_list" class="text_pole"></select>
                        <div class="flex-container">
                            <input id="TTSSorcery_preset_new" class="menu_button" type="button" value="New preset">
                            <input id="TTSSorcery_preset_import" class="menu_button" type="button" value="Import">
                            <input id="TTSSorcery_preset_export" class="menu_button" type="button" value="Export">
                            <input id="TTSSorcery_preset_delete" class="menu_button" type="button" value="Delete">
                            <input type="file" id="TTSSorcery_preset_import_file" accept="application/json" style="display:none;">
                        </div>
                        <small>A preset stores the model, language, speaking rate, voice quality score, and denoising choice from this tab. Changing a setting above updates the active preset.</small>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>`

    $("#extensions_settings").append(settingsHtml);

    $("#TTSSorcery_enabled").on("input", onEnabledInput);
    $("#TTSSorcery_model").on("input", onModelChoiceInput);
    $("#TTSSorcery_language_iso_code").on("input", onLanguageInput);
    $("#TTSSorcery_force_neutral_narrator").on("input", function() {
        extension_settings[extensionName].force_neutral_narrator = !!$(this).prop("checked");
        saveSettingsDebounced();
    });
    
    $("#TTSSorcery_speaking_rate").on("input", onSliderInput);
    $("#TTSSorcery_vqscore").on("input", onSliderInput);
    
    $("#TTSSorcery_speaking_rate_value").on("input", onCounterInput);
    $("#TTSSorcery_vqscore_value").on("input", onCounterInput);
    $("#TTSSorcery_auto_generation").on("input", onAutoGenerationInput);
    
    loadSettings();
    setupEventHandlers();
    initializeVoiceDrawers();
    
    addTTSSorceryToWandMenu();
    
    injectTTSSorceryRegexToRegexExtension();

    function addTTSSorceryNarrateButtons() {
        if (!extension_settings || !extension_settings[extensionName] || !extension_settings[extensionName].enabled) {
                return;
        }
    
        $('.extraMesButtons').each(function() {
            if ($(this).find('.mes_button_TTSSorcery').length === 0) {
                $(this).append(`
                    <div title="TTSSorcery Narrate" class="mes_button mes_button_TTSSorcery fa-solid fa-wand-magic-sparkles" data-i18n="[title]TTSSorcery Narrate"></div>
                `);
            }
        });
    
        $(document).off('click', '.mes_button_TTSSorcery');
        $(document).on('click', '.mes_button_TTSSorcery', onTTSSorceryNarrateClick);
    }
    
    // I know of no host event for "a message was rendered", so I poll
    // once a second and add the wand button to any message block that
    // lacks one. Inside the function, the off and on pair stops the
    // click handler from stacking up again on every pass.
    setInterval(addTTSSorceryNarrateButtons, 1000);
});

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function onVoiceChange() {
    instructionsInjected = false;
}

function addTTSSorceryToWandMenu() {
    $('#extensionsMenu').find('#tts_wand_container').append(`
        <div id="TTSSorceryPlaybackMenuItem" class="list-group-item flex-container flexGap5">
            <div id="TTSSorcery_playback_control" class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div>
            Toggle TTSSorcery Playback
        </div>`);
    
    $('#TTSSorceryPlaybackMenuItem').attr('title', 'Play/stop TTSSorcery TTS').on('click', onTTSSorceryPlaybackClicked);
    
    updateTTSSorceryPlaybackUI();
}

function processMessageForTTS(messageText) {
    console.log("Processing message for TTS:", messageText.substring(0, 50) + "...");
    
    // The extra processTtsQueue call after processSegments below looks
    // like a duplicate, and mostly it is: processSegments already queues
    // its segments and starts playback when idle. The second call only
    // matters when playback was already running, where it kicks the
    // preload path for the segments just added.
    resetTtsQueue(true);
    
    const markers = extractTTSInfo(messageText);
    
    if (markers.length > 0) {
        console.log(`Found ${markers.length} TTS markers in message`);
        
        const segments = processSegments(messageText, markers);
        
        processTtsQueue();
    } else {
        console.log("No TTS markers found in message");
        toastr.warning("No TTS markers found in this message");
    }
}

function onTTSSorceryPlaybackClicked() {
    if (isPlayingTts) {
        resetTtsQueue(true);
        toastr.info("TTSSorcery playback stopped");
    } else {
        const context = getContext();
        if (context.chat && context.chat.length > 0) {
            const latestMessage = context.chat[context.chat.length - 1];
            
            if (!latestMessage.is_user && latestMessage.mes) {
                toastr.info("TTSSorcery processing latest message");
                processMessageForTTS(latestMessage.mes);
            } else {
                toastr.warning("Last message is not a character message");
            }
        }
    }
    
    updateTTSSorceryPlaybackUI();
}

function updateTTSSorceryPlaybackUI() {
    if (extension_settings[extensionName].enabled == true) {
        $('#TTSSorceryPlaybackMenuItem').show();
        
        let iconClass = '';
        if (isPlayingTts || currentAudio) {
            iconClass = 'fa-solid fa-wand-magic-sparkles fa-beat extensionsMenuExtensionButton';
        } else {
            iconClass = 'fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton';
        }
        
        $('#TTSSorcery_playback_control').attr('class', iconClass);
    } else {
        $('#TTSSorceryPlaybackMenuItem').hide();
    }
}

function onTTSSorceryNarrateClick(event) {
    const messageBlock = $(event.target).closest('.mes');
    const messageId = messageBlock.attr('mesid');
    const context = getContext();
    
    if (context.chat && messageId !== undefined) {
        const message = context.chat[messageId];
        
        if (message && message.mes) {
            console.log(`Processing message ${messageId} for TTS`);
            toastr.info(`TTSSorcery processing message from ${message.name || 'character'}`);
            
            resetTtsQueue(true);
            
            const markers = extractTTSInfo(message.mes);
            
            if (markers.length > 0) {
                console.log(`Found ${markers.length} TTS markers in message`);
                
                const segments = processSegments(message.mes, markers);
                
                processTtsQueue();
            } else {
                console.log("No TTS markers found in message");
                toastr.warning("No TTS markers found in this message");
            }
        } else {
            toastr.error("Could not find message content");
        }
    } else {
        toastr.error("Could not find message in chat context");
    }
}

function injectTTSSorceryRegexToRegexExtension() {
    if (!extension_settings.regex) {
        console.log(`${extensionName}: Regex extension not loaded, cannot inject regex pattern.`);
        return;
    }
    
    const existingScript = extension_settings.regex.find(
        script => script.scriptName === 'TTSSorcery TTS Markers'
    );
    
    if (existingScript) {
        console.log(`${extensionName}: TTSSorcery regex already exists in Regex extension.`);
        return;
    }
    
    // The find pattern below is the marker grammar from extractTTSInfo,
    // written a second time as a string. The Regex extension uses its
    // copy to strip markers out of the rendered chat, and this file
    // uses the original to find the same markers for playback. If I
    // change one copy and not the other, display and playback drift
    // apart and nobody gets an error about it.
    const ttsSorceryRegex = {
        id: `ttssorcery-${Date.now()}`,
        scriptName: 'TTSSorcery TTS Markers',
        findRegex: '/§([nac])(:([^§|]*))?(\\|([^§|]*))?(\\|([^§]*))?§/g',
        replaceString: '',
        trimStrings: [],
        placement: [1, 2, 3],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: false,
        substituteRegex: 0
    };
    
    extension_settings.regex.push(ttsSorceryRegex);
    saveSettingsDebounced();
    console.log(`${extensionName}: Successfully injected TTSSorcery regex pattern into Regex extension.`);
}

// The auto generation checkbox is wired by onAutoGenerationInput
// inside the ready callback, where the settings HTML exists. A second
// binding at module load would attach to an empty selection, so there
// is none here on purpose.