/* Personal relay adaptation; MPL-2.0. Original PayGo UI by Mana Nekoha. */
import { normalizePrice } from './cost-model.js';
const MARK = '__personalRelayCostState';
const PATH = '/api/backends/chat-completions/generate';
export const baseModel = model => String(model ?? '').replace(/^抗截断-/, '').replace(/^google\//, '');
export function isPersonalRelay(data, context = {}) {
    if (String(data?.chat_completion_source ?? data?.source ?? '').toLowerCase() !== 'custom') return false;
    try {
        const url = new URL(data.custom_url ?? context.chatCompletionSettings?.custom_url);
        return (url.hostname === 'personal-vertex-relay.personal-vertex-relay.workers.dev' && url.protocol === 'https:'
            || ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '8788')
            && /^\/v1\/?$/.test(url.pathname);
    } catch { return false; }
}
export function resolveRelayRecord(record, quote) {
    const model = baseModel(record.model);
    const tier = ({ ON_DEMAND: 'standard', ON_DEMAND_FLEX: 'flex', ON_DEMAND_PRIORITY: 'priority' })[record.usage?.trafficType];
    const price = normalizePrice(quote?.price);
    const valid = quote?.provider === 'personal-vertex-relay' && quote.version === 1
        && quote.base_model === model && tier && quote.actual_tier === tier && price;
    return { ...record, source: 'vertexai', model, personalRelay: true,
        tier: tier ?? 'unknown', price: valid ? price : null, priceConfirmed: Boolean(valid) };
}
export function installPersonalRelay({ context, target = globalThis, usageClient, messageCosts, captureUsageContext }) {
    const original = target.fetch;
    const restores = [];
    const cost = (method, ...args) => {
        try { return messageCosts?.[method]?.(...args); }
        catch (error) { console.warn('[Personal relay] Cost observation failed', error); }
    };
    function mark(data, background = false) {
        if (!data || typeof data !== 'object') return data;
        if (!background && !isPersonalRelay(data, context)) return data;
        if (!data[MARK]) {
            const chatId = captureUsageContext();
            data[MARK] = { id: globalThis.crypto.randomUUID(), chatId, startedAt: Date.now(), background,
                token: background ? null : cost('capture', data, chatId) };
        }
        return data;
    }
    // Service requests belong to summaries/database extensions, not the current reply.
    for (const name of ['processRequest', 'sendRequest']) {
        const service = context.ChatCompletionService;
        if (typeof service?.[name] !== 'function') continue;
        const prior = service[name];
        const wrapped = function(data, ...args) { return prior.call(this, data && typeof data === 'object' ? mark({ ...data }, true) : data, ...args); };
        service[name] = wrapped;
        restores.push(() => { if (service[name] === wrapped) service[name] = prior; });
    }
    const manager = context.ConnectionManagerRequestService;
    if (typeof manager?.sendRequest === 'function') {
        const prior = manager.sendRequest;
        const wrapped = function(id, prompt, max, custom, override = {}, ...args) {
            const profile = this.getProfile?.(id);
            const payload = { ...override };
            if (String(profile?.api).toLowerCase() === 'custom') {
                const chatId = captureUsageContext();
                payload[MARK] = { id: globalThis.crypto.randomUUID(), chatId, startedAt: Date.now(), background: true, token: null };
            }
            return prior.call(this, id, prompt, max, custom, payload, ...args);
        };
        manager.sendRequest = wrapped;
        restores.push(() => { if (manager.sendRequest === wrapped) manager.sendRequest = prior; });
    }
    const wrappedFetch = async function(input, init) {
        let url;
        try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, target.location?.origin); } catch { return original.call(this, input, init); }
        if (url.pathname !== PATH || url.origin !== target.location?.origin
            || String(init?.method ?? input?.method ?? 'GET').toUpperCase() !== 'POST') return original.call(this, input, init);
        const fallbackChatId = captureUsageContext();
        const raw = typeof init?.body === 'string' ? init.body : init?.body == null && input?.clone ? await input.clone().text() : null;
        if (!raw) return original.call(this, input, init);
        let data;
        try { data = JSON.parse(raw); } catch { return original.call(this, input, init); }
        const state = data[MARK];
        if (!isPersonalRelay(data, context)) {
            if (!state) return original.call(this, input, init);
            delete data[MARK];
            return original.call(this, input, { ...init, body: JSON.stringify(data) });
        }
        delete data[MARK];
        const meta = { id: state?.id ?? globalThis.crypto.randomUUID(), chatId: state?.chatId ?? fallbackChatId,
            startedAt: state?.startedAt ?? Date.now(), source: 'vertexai', model: data.model, tier: 'unknown', stream: Boolean(data.stream) };
        const token = state?.background ? null : state?.token;
        const signal = init?.signal ?? input?.signal;
        try {
            signal?.throwIfAborted();
            if (token) { cost('prepared', token, meta.id, meta); cost('started', token); }
            const response = await original.call(this, input, { ...init, body: JSON.stringify(data) });
            const observed = meta.chatId ? usageClient.observeResponse(response, meta, { signal, resolveRecord: resolveRelayRecord }) : response;
            return token ? cost('response', token, observed, signal) ?? observed : observed;
        } catch (error) {
            if (meta.chatId) usageClient.recordFailure(meta, error);
            if (token) cost('failed', token);
            throw error;
        }
    };
    target.fetch = wrappedFetch;
    const ready = data => mark(data);
    ready.destroy = () => { if (target.fetch === wrappedFetch) target.fetch = original; for (const restore of restores.reverse()) restore(); };
    return ready;
}
