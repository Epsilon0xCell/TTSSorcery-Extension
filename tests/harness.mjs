// Test harness for index.js.
//
// index.js only runs inside SillyTavern: it imports host modules by
// relative path and talks to host globals (jQuery, toastr, Audio). I load
// it here by stripping the import lines and injecting stubs for every
// host name it expects, so the marker parsing, queue, preload, preset,
// and stream hook code run under plain Node with no network. The fetch
// stub records requests instead of sending them; the API key used in
// these tests is a short fake string, not a real key.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

class Chain {
    on() { return this; }
    off() { return this; }
    empty() { return this; }
    append() { return this; }
    html() { return this; }
    text() { return this; }
    show() { return this; }
    hide() { return this; }
    toggle() { return this; }
    attr() { return this; }
    find() { return this; }
    closest() { return this; }
    val() { return ''; }
    prop() { return this; }
    data() { return undefined; }
    click() { return this; }
    remove() { return this; }
    each() { return this; }
}

export function loadExtension() {
    const raw = readFileSync(join(here, '..', 'index.js'), 'utf8');
    const body = raw
        .split('\n')
        .filter(line => !line.startsWith('import '))
        .join('\n');

    const settings = {
        enabled: true,
        api_key: 'TESTKEY',
        model: 'zonos-v0.1-hybrid',
        language_iso_code: 'en-us',
        speaking_rate: 15,
        vqscore: 0.78,
        speaker_noised: false,
        disable_narrator: false,
        action_handling: 'narrator',
        max_preload: 5,
        segment_gap: 0,
        auto_generation: false,
        force_neutral_narrator: false,
        voices: {
            narrator: {
                name: 'Narrator',
                audioFiles: {
                    default: { file: 'data:audio/mp3;base64,QUJD', fileName: 'n.mp3', duration: 1 },
                },
            },
        },
    };

    const context = { chatId: 'chat-1', chat: [], callPopup: async () => null };
    const extension_settings = { TTSSorcery: settings };
    const handlers = {};
    const eventSource = { on: (name, fn) => { handlers[name] = fn; } };
    const event_types = new Proxy({}, { get: (t, k) => String(k) });
    const streamingProcessor = { onProgressStreaming: () => 'original-result' };
    const fetchCalls = [];
    const fetchStub = async (url, opts) => {
        fetchCalls.push({ url, opts });
        return { ok: true, blob: async () => new Blob(['x'], { type: 'audio/webm' }), text: async () => '' };
    };
    class AudioStub {
        play() { return Promise.resolve(); }
        pause() {}
    }
    const toastrCalls = [];
    const toastr = {
        error: (...a) => toastrCalls.push(['error', ...a]),
        warning: (...a) => toastrCalls.push(['warning', ...a]),
        info: (...a) => toastrCalls.push(['info', ...a]),
        success: (...a) => toastrCalls.push(['success', ...a]),
    };
    const $ = () => new Chain();
    const jQuery = () => new Chain();
    const quietConsole = { log() {}, error() {}, warn() {} };

    const factory = new Function(
        'extension_settings', 'getContext', 'loadExtensionSettings', 'saveSettingsDebounced',
        'power_user', 'promptManager', 'eventSource', 'event_types', 'streamingProcessor',
        'Handlebars', '$', 'jQuery', 'toastr', 'Audio', 'fetch', 'console',
        body + `\n;return {
            extractTTSInfo, processSegments, resetTtsQueue, preloadTtsSegment, preloadTtsSegments,
            loadAndPlaySegment, refreshPresetList, getCurrentPreset, mapEmotionsToZyphraFormat,
            getBase64AudioData, formatEmotions, fixFormatting, installStreamHook,
            getQueue: () => ttsQueue,
            setQueue: (q) => { ttsQueue = q; },
            getLoading: () => loadingSegments,
            getPreloaded: () => preloadedAudios,
            isPlaying: () => isPlayingTts,
        };`
    );

    const api = factory(
        extension_settings,
        () => context,
        () => {},
        () => {},
        {},
        {},
        eventSource,
        event_types,
        streamingProcessor,
        {},
        $,
        jQuery,
        toastr,
        AudioStub,
        fetchStub,
        quietConsole,
    );

    return { api, settings, context, handlers, streamingProcessor, fetchCalls, toastrCalls };
}

export const tick = () => new Promise(resolve => setTimeout(resolve, 20));
