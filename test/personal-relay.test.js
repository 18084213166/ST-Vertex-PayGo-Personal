import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'yaml';
import { initTauriTavern } from '../src/tauri-runtime.js';
import { getMessageCost, createMessageCosts } from '../src/message-costs.js';
import { estimateRecord } from '../src/cost-model.js';
import { isPersonalRelay, resolveRelayRecord } from '../src/personal-relay.js';
import { nativeContext, nativeDocument, nativeStore } from './helpers/native-dom.js';
const usageMetadata = { promptTokenCount: 1000, cachedContentTokenCount: 400, candidatesTokenCount: 100,
    thoughtsTokenCount: 200, trafficType: 'ON_DEMAND_FLEX' };
const relay_metadata = { provider: 'personal-vertex-relay', version: 1, base_model: 'gemini-4-hydrogen',
    actual_tier: 'flex', price: { input: 2, cachedInput: 0.2, output: 8 } };
const url = 'https://personal-vertex-relay.personal-vertex-relay.workers.dev/v1';
for (const model of ['gemini-4-hydrogen', '抗截断-google/gemini-4-hydrogen']) {
    test(`fragmented streaming ${model}: exact bytes, quote, message and teardown`, async t => {
        const context = nativeContext(), store = nativeStore(), documentRef = nativeDocument();
        context.chat = [{ is_user: true }];
        Object.assign(context.eventTypes, { GENERATION_AFTER_COMMANDS: 'generation', MESSAGE_RECEIVED: 'message' });
        Object.assign(context.chatCompletionSettings, { chat_completion_source: 'custom', custom_url: url, custom_model: model });
        const raw = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'
            + `data: ${JSON.stringify({ usageMetadata, relay_metadata })}\n\ndata: [DONE]\n\n`;
        const bytes = new TextEncoder().encode(raw);
        let sent, tracker;
        const originalFetch = async (_input, init) => {
            sent = JSON.parse(init.body);
            return new Response(new ReadableStream({ start(controller) {
                for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
                controller.close();
            } }), { headers: { 'content-type': 'text/event-stream' } });
        };
        const target = { document: documentRef, fetch: originalFetch, location: { origin: 'http://tauri.localhost' },
            __TAURITAVERN__: { api: { extension: { store }, llmConnections: { save: async () => {} } } },
            setInterval: () => 1, clearInterval() {} };
        const runtime = await initTauriTavern({ target, getContext: () => context, loadLibrary: async () => ({ yaml }),
            factories: { refreshPolicy: async () => ({ changed: false }),
                messageCosts(options) { tracker = createMessageCosts({ ...options, retryMs: 60000 }); return tracker; } } });
        t.after(() => runtime.destroy());
        await context.eventSource.emit('generation', 'normal', {}, false);
        const data = { chat_completion_source: 'custom', custom_url: url, model, stream: true, type: 'normal' };
        await context.eventSource.emit('request', data);
        const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(data) });
        assert.equal(await response.text(), raw);
        await runtime.usageClient.flush();
        const reply = { is_user: false, extra: {}, swipe_id: 0 };
        context.chat.push(reply); await context.eventSource.emit('message', 1, 'normal');
        await tracker.refresh();
        const record = [...store.files.values()][0];
        assert.equal(record.tier, 'flex');
        assert.equal(record.model, 'gemini-4-hydrogen');
        assert.deepEqual(record.usage, usageMetadata);
        assert.equal(estimateRecord(record).amount, (600 * 2 + 400 * 0.2 + 300 * 8) / 1e6);
        assert.equal(getMessageCost(reply).requests[0].id, record.id);
        assert.equal(Object.keys(sent).some(key => key.startsWith('__')), false);
        assert.equal(sent.model, model);
        assert.equal(sent.custom_include_headers, undefined);
        runtime.destroy(); assert.equal(target.fetch, originalFetch);
    });
}
test('missing, stale-model or wrong-tier quote never falls back to guessed prices', () => {
    const record = { model: '抗截断-gemini-4-hydrogen', usage: usageMetadata, status: 'complete' };
    for (const quote of [null, { ...relay_metadata, base_model: 'other' }, { ...relay_metadata, actual_tier: 'standard' }]) {
        const resolved = resolveRelayRecord(record, quote);
        assert.equal(estimateRecord(resolved, relay_metadata.price).amount, null);
    }
});
test('adapter scope excludes other custom endpoints and non-custom sources', () => {
    assert.equal(isPersonalRelay({ chat_completion_source: 'custom', custom_url: url }), true);
    assert.equal(isPersonalRelay({ chat_completion_source: 'custom', custom_url: 'https://other.example/v1' }), false);
    assert.equal(isPersonalRelay({ chat_completion_source: 'vertexai', custom_url: url }), false);
});
