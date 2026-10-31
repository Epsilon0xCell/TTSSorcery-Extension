// Tests for TTSSorcery index.js. Run with: node --test tests/
// Every test loads a fresh copy of the extension through harness.mjs,
// with the SillyTavern host stubbed and fetch recorded, never sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension, tick } from './harness.mjs';

test('extractTTSInfo parses a character marker with voice file and emotions', () => {
    const { api } = loadExtension();
    const markers = api.extractTTSInfo('§c:Elara|female_young.mp3|e1:0.7,e5:0.3§Hello there');
    assert.equal(markers.length, 1);
    assert.equal(markers[0].type, 'c');
    assert.equal(markers[0].character, 'Elara');
    assert.equal(markers[0].voiceFile, 'female_young.mp3');
    assert.deepEqual(markers[0].emotions, { e1: 0.7, e5: 0.3 });
});

test('extractTTSInfo defaults a bare narrator marker to Narrator and default.mp3', () => {
    const { api } = loadExtension();
    const markers = api.extractTTSInfo('§n§Some narration');
    assert.equal(markers.length, 1);
    assert.equal(markers[0].character, 'Narrator');
    assert.equal(markers[0].voiceFile, 'default.mp3');
    assert.deepEqual(markers[0].emotions, {});
});

test('extractTTSInfo finds no markers in plain text', () => {
    const { api } = loadExtension();
    assert.deepEqual(api.extractTTSInfo('just a normal message'), []);
});

test('processSegments queues a narrator segment with the marker emotions', async () => {
    const { api } = loadExtension();
    const text = '§n|default.mp3|e2:0.2,e8:0.8§The night was quiet.';
    const segments = api.processSegments(text, api.extractTTSInfo(text));
    assert.equal(segments.length, 1);
    assert.equal(segments[0].type, 'n');
    assert.deepEqual(segments[0].emotions, { e2: 0.2, e8: 0.8 });
    assert.match(segments[0].text, /night was quiet/);
    await tick();
});

test('processSegments returns no segments when the extension is disabled', () => {
    const { api, settings } = loadExtension();
    settings.enabled = false;
    assert.deepEqual(api.processSegments('anything', []), []);
});

test('a bare resetTtsQueue call keeps the queue and does not throw', async () => {
    const { api } = loadExtension();
    const text = '§n§Queued line';
    api.processSegments(text, api.extractTTSInfo(text));
    await tick();
    assert.doesNotThrow(() => api.resetTtsQueue());
    assert.ok(api.getQueue().length > 0, 'non-forced reset should preserve the queue');
});

test('a forced resetTtsQueue clears the queue', async () => {
    const { api } = loadExtension();
    const text = '§n§Queued line';
    api.processSegments(text, api.extractTTSInfo(text));
    await tick();
    api.resetTtsQueue(true);
    assert.equal(api.getQueue().length, 0);
    assert.equal(api.isPlaying(), false);
});

test('preloadTtsSegment sends a built request body and stores the audio', async () => {
    const { api, fetchCalls } = loadExtension();
    api.setQueue([{
        type: 'n', character: 'Narrator', voiceFile: 'default.mp3',
        emotions: { e8: 1.0 }, text: 'A line to preload', chatId: 'chat-1',
    }]);
    api.getLoading().add(0);
    api.preloadTtsSegment(0);
    await tick();
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /^https:\/\/api\.zyphra\.com\//);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    assert.match(sent.text, /line to preload/);
    assert.equal(sent.speaker_audio, 'QUJD');
    assert.equal(sent.model, 'zonos-v0.1-hybrid');
    assert.equal(api.getPreloaded().length, 1);
    assert.equal(api.getLoading().has(0), false);
});

test('preloadTtsSegment with no voice sample clears its loading mark', async () => {
    const { api, settings, fetchCalls } = loadExtension();
    settings.voices.narrator.audioFiles.default.file = null;
    api.setQueue([{
        type: 'n', character: 'Narrator', voiceFile: 'default.mp3',
        emotions: {}, text: 'No sample for this one', chatId: 'chat-1',
    }]);
    api.getLoading().add(0);
    api.preloadTtsSegment(0);
    await tick();
    assert.equal(fetchCalls.length, 0);
    assert.equal(api.getLoading().has(0), false, 'index must not stay marked as loading');
});

test('refreshPresetList seeds a Default preset when none are stored', () => {
    const { api, settings } = loadExtension();
    assert.equal(settings.presets, undefined);
    api.refreshPresetList();
    assert.equal(settings.presets.length, 1);
    assert.equal(settings.presets[0].name, 'Default');
    assert.equal(settings.active_preset, 'Default');
    assert.equal(api.getCurrentPreset().name, 'Default');
});

test('mapEmotionsToZyphraFormat maps known codes and drops unknown ones', () => {
    const { api } = loadExtension();
    assert.deepEqual(api.mapEmotionsToZyphraFormat({ e1: '0.5', e6: 0.25, e9: 1 }), { happiness: 0.5, anger: 0.25 });
    assert.deepEqual(api.mapEmotionsToZyphraFormat({}), {});
    assert.deepEqual(api.mapEmotionsToZyphraFormat(null), {});
});

test('getBase64AudioData strips a data URL prefix and passes raw base64 through', () => {
    const { api } = loadExtension();
    assert.equal(api.getBase64AudioData('data:audio/mp3;base64,QUJD'), 'QUJD');
    assert.equal(api.getBase64AudioData('QUJD'), 'QUJD');
});

test('formatEmotions names the codes', () => {
    const { api } = loadExtension();
    assert.equal(api.formatEmotions({ e1: 0.5, e8: 0.5 }), 'Happiness: 0.5, Neutral: 0.5');
});

test('the stream hook restores the original callback on generation start', () => {
    const { api, settings, handlers, streamingProcessor } = loadExtension();
    settings.auto_generation = true;
    const original = streamingProcessor.onProgressStreaming;
    api.installStreamHook();
    assert.notEqual(streamingProcessor.onProgressStreaming, original);
    handlers['GENERATION_STARTED']();
    assert.equal(streamingProcessor.onProgressStreaming, original, 'wrapper must be removed, not left in the chain');
});

test('reinstalling the stream hook after a reset does not stack wrappers', () => {
    const { api, settings, handlers, streamingProcessor } = loadExtension();
    settings.auto_generation = true;
    let originalCalls = 0;
    streamingProcessor.onProgressStreaming = () => { originalCalls++; };
    api.installStreamHook();
    handlers['GENERATION_STARTED']();
    api.installStreamHook();
    streamingProcessor.onProgressStreaming(1, 'x', false);
    assert.equal(originalCalls, 1, 'one stream update must reach the original callback exactly once');
});
