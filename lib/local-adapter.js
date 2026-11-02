/**
 * LLM adapter backed by the local OpenCode service.
 *
 * Two constraints shape this file:
 *
 * 1. opencode.ai's free tier only answers requests its own client makes, so we
 *    drive the installed client's loopback server instead of calling the API.
 * 2. That server is a complete agent — it owns tool declarations and runs tools
 *    itself — while `dsh-llm` has no "provider already executed this" block. So
 *    tools cannot be forwarded as a protocol channel.
 *
 * The resolution: OpenCode is used purely as a model backend. DSH's tool schemas
 * are rendered into the prompt (see `tool-protocol.js`), the model answers with a
 * fenced JSON envelope when it wants a tool, and this adapter turns that into
 * native DSH `tool-call` blocks. DSH executes the tool, so its permissions,
 * approvals, and skills remain authoritative.
 *
 * Event mapping (live capture, opencode 2.2.5):
 *   session.reasoning.delta -> reasoning-delta
 *   session.text.delta      -> text-delta (scanned for the tool envelope)
 *   session.step.ended      -> usage + finish
 */
import { LlmAdapter, LlmError, ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import {
    ToolFenceDetector,
    parseToolCalls,
    renderToolProtocol,
    renderToolResult,
} from './tool-protocol.js';

/** Text of one message, joining its text blocks. */
function textOf(message) {
    const parts = Array.isArray(message.content) ? message.content : [];
    const out = [];
    for (const part of parts) {
        if (part?.type === 'text' && typeof part.text === 'string') out.push(part.text);
    }
    return out.join('\n').trim();
}

/** Image blocks in one message, as data URLs the local service accepts. */
function imagesOf(message) {
    const parts = Array.isArray(message.content) ? message.content : [];
    const files = [];
    for (const part of parts) {
        if (part?.type !== 'image') continue;
        const url = typeof part.dataUrl === 'string'
            ? part.dataUrl
            : typeof part.base64 === 'string' && typeof part.mediaType === 'string'
                ? `data:${part.mediaType};base64,${part.base64}`
                : undefined;
        if (!url) continue;
        files.push({ uri: url, ...(typeof part.name === 'string' ? { name: part.name } : {}) });
    }
    return files;
}

/**
 * Flatten DSH history into the single prompt string the local API accepts,
 * plus any images that ride along with the newest turn.
 *
 * Tool results are folded in inline: the model must see what a tool returned
 * before it can decide the next step.
 */
function buildPrompt(messages, toolProtocol) {
    const blocks = [];
    if (toolProtocol) blocks.push(toolProtocol);

    const history = [];
    let pendingImages = [];
    for (const message of messages.slice(0, -1)) {
        const text = textOf(message);
        if (message.role === 'tool') {
            const result = renderToolResult(message);
            history.push(`Tool result (${String(message.toolCallId ?? 'call')}): ${result}`);
            continue;
        }
        if (message.role === 'assistant') {
            const calls = (Array.isArray(message.content) ? message.content : [])
                .filter((part) => part?.type === 'tool-call')
                .map((part) => ({ name: part.name, arguments: part.arguments }));
            if (calls.length) {
                history.push(`Assistant called tools: ${JSON.stringify(calls)}`);
            }
            if (text) history.push(`Assistant: ${text}`);
            continue;
        }
        if (text) history.push(`${message.role === 'system' ? 'System' : 'User'}: ${text}`);
    }

    const last = messages[messages.length - 1];
    const current = last ? textOf(last) : '';
    pendingImages = last ? imagesOf(last) : [];

    if (history.length) {
        blocks.push('## Conversation so far', '', history.join('\n\n'));
    }
    blocks.push('## Current request', '', current || '(no text)');

    return { prompt: blocks.join('\n'), files: pendingImages };
}

function errorCodeFor(error) {
    if (error?.name === 'TimeoutError') return 'TIMEOUT';
    return 'STREAM_FAILED';
}

export class LocalOpenCodeAdapter extends LlmAdapter {
    constructor(service, options = {}) {
        super();
        this.service = service;
        this.options = options;
        this.models = options.models ?? { list: async () => [] };
        this.logger = options.logger ?? { info() {}, warn() {}, debug() {}, error() {} };
    }

    providerInfo(provider) {
        return { id: provider, name: 'OpenCode' };
    }

    async listModels(provider) {
        const models = await this.models.list();
        return models.map((model) => this.toModelInfo(provider, model));
    }

    async resolveModel(provider, model) {
        const models = await this.models.list().catch(() => []);
        return this.resolvedModelInfo(provider, String(model), models.find((entry) => entry.id === model));
    }

    providerRetryPolicy(_provider) {
        return resolveRetryPolicy({
            mode: 'normal',
            maxRetries: 2,
            retryableCodes: ['RATE_LIMIT', 'PROVIDER_HTTP_ERROR', 'STREAM_FAILED'],
            backoff: { initialDelayMs: 1000, maxDelayMs: 30_000, jitterRatio: 0.2 },
        }, 'opencode-local retry policy');
    }

    toModelInfo(provider, model) {
        return {
            provider,
            id: model.id,
            name: model.name ?? model.id,
            ...(model.description ? { description: model.description } : {}),
            ...(model.inputModalities?.length ? { inputModalities: [...model.inputModalities] } : {}),
        };
    }

    /**
     * Per-call descriptor. The host reads context sizing and reasoning support
     * from here, not from `listModels`, which only feeds the picker.
     */
    resolvedModelInfo(provider, model, found) {
        const base = found
            ? this.toModelInfo(provider, found)
            : { provider, id: model, name: model, inputModalities: ['text'] };
        const efforts = (found?.efforts ?? []).map((effort) => ({
            id: ReasoningEffortId(String(effort.id)),
            name: String(effort.name ?? effort.id),
        }));
        return {
            ...base,
            ...(found?.contextWindow ? { context: { contextWindow: found.contextWindow } } : {}),
            ...(found?.maxOutputTokens ? { defaultMaxTokens: found.maxOutputTokens } : {}),
            ...(efforts.length ? { reasoning: { efforts } } : {}),
        };
    }

    async prepareCall(provider, model) {
        const models = await this.models.list().catch(() => []);
        const info = models.find((entry) => entry.id === model);
        return {
            model: this.resolvedModelInfo(provider, String(model), info),
            stream: (options) => this.streamWithModel(options),
        };
    }

    stream(options) {
        return this.streamWithModel(options);
    }

    async *streamWithModel(options) {
        const { messages = [], signal, tools } = options;
        const modelId = String(options.model);

        let outputStarted = false;
        let open = null;
        let blockIndex = 0;
        let usage;
        let finishKind = null;

        function* closeBlock() {
            if (!open) return;
            yield {
                type: 'block-end',
                index: open.index,
                block: open.kind === 'text'
                    ? { type: 'text', text: open.text }
                    : { type: 'reasoning', text: open.text },
            };
            open = null;
        }

        try {
            const service = await this.service.start();

            // The service silently falls back to its default model on an unknown id,
            // so a typo would otherwise answer as some other model and look fine.
            const known = await this.models.list().catch(() => []);
            if (known.length > 0 && !known.some((entry) => entry.id === modelId)) {
                throw new LlmError(`Unknown OpenCode model "${modelId}"`, 'PROVIDER_HTTP_ERROR');
            }

            const toolProtocol = renderToolProtocol(tools);
            const { prompt, files } = buildPrompt(messages, toolProtocol);
            if (!prompt.trim()) {
                yield { type: 'finish', reason: { kind: 'stop' } };
                return;
            }

            const eventsAbort = new AbortController();
            const onAbort = () => eventsAbort.abort(signal?.reason);
            signal?.addEventListener('abort', onAbort, { once: true });

            // Subscribe before prompting: the first delta can arrive before the POST
            // resolves, and a listener attached afterwards would miss it.
            const eventResponse = await fetch(`${service.origin}/api/event`, {
                headers: service.headers(),
                signal: eventsAbort.signal,
            });
            if (!eventResponse.ok || !eventResponse.body) {
                throw new LlmError(`local OpenCode event stream HTTP ${eventResponse.status}`, 'PROVIDER_HTTP_ERROR');
            }

            const sessionResponse = await fetch(`${service.origin}/api/session`, {
                method: 'POST',
                headers: { ...service.headers(), 'content-type': 'application/json' },
                body: JSON.stringify({ directory: this.options.directory ?? process.cwd() }),
                signal: eventsAbort.signal,
            });
            if (!sessionResponse.ok) {
                throw new LlmError(`local OpenCode session HTTP ${sessionResponse.status}`, 'PROVIDER_HTTP_ERROR');
            }
            const sessionBody = await sessionResponse.json();
            const sessionId = sessionBody?.data?.id ?? sessionBody?.id;
            if (!sessionId) throw new LlmError('local OpenCode returned no session id', 'PROVIDER_HTTP_ERROR');

            // The model must be pinned explicitly: the session default is whatever the
            // user last picked in the OpenCode app, not the model DSH asked for.
            await fetch(`${service.origin}/api/session/${encodeURIComponent(sessionId)}/model`, {
                method: 'POST',
                headers: { ...service.headers(), 'content-type': 'application/json' },
                body: JSON.stringify({ model: { providerID: 'opencode', id: modelId } }),
                signal: eventsAbort.signal,
            }).then((response) => response.body?.cancel()).catch(() => {});

            const promptBody = { text: prompt, ...(files.length ? { files } : {}) };
            const promptResponse = await fetch(`${service.origin}/api/session/${encodeURIComponent(sessionId)}/prompt`, {
                method: 'POST',
                headers: { ...service.headers(), 'content-type': 'application/json' },
                body: JSON.stringify(promptBody),
                signal: eventsAbort.signal,
            });
            if (!promptResponse.ok) {
                const detail = await promptResponse.text().catch(() => '');
                throw new LlmError(
                    `local OpenCode prompt HTTP ${promptResponse.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
                    promptResponse.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_HTTP_ERROR',
                );
            }
            await promptResponse.body?.cancel();

            const detector = new ToolFenceDetector();
            const pendingCalls = [];
            const decoder = new TextDecoder();
            let buffer = '';

            outer: for await (const chunk of eventResponse.body) {
                buffer += decoder.decode(chunk, { stream: true });
                let index;
                while ((index = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);
                    const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
                    if (!line) continue;
                    let event;
                    try {
                        event = JSON.parse(line.slice(6));
                    }
                    catch {
                        continue;
                    }
                    const data = event.data;
                    // Other sessions and workspaces share this service; filter by id.
                    if (!data || data.sessionID !== sessionId) continue;

                    if (event.type === 'session.reasoning.delta') {
                        if (open?.kind !== 'reasoning') {
                            yield* closeBlock();
                            yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' };
                            open = { index: blockIndex, kind: 'reasoning', text: '' };
                            blockIndex++;
                            outputStarted = true;
                        }
                        open.text += data.delta;
                        yield { type: 'reasoning-delta', index: open.index, text: data.delta };
                    }
                    else if (event.type === 'session.text.delta') {
                        // Tool calls are detected inside the text stream, so text can
                        // arrive here that belongs to an envelope rather than prose.
                        const { prose, opened } = detector.push(data.delta);
                        if (prose) {
                            if (open?.kind !== 'text') {
                                yield* closeBlock();
                                yield { type: 'block-start', index: blockIndex, blockType: 'text' };
                                open = { index: blockIndex, kind: 'text', text: '' };
                                blockIndex++;
                                outputStarted = true;
                            }
                            open.text += prose;
                            yield { type: 'text-delta', index: open.index, text: prose };
                        }
                        if (opened) pendingCalls.push(...parseToolCalls(opened));
                    }
                    else if (event.type === 'session.step.ended') {
                        finishKind = data.finish === 'length' ? 'max-tokens' : 'stop';
                        if (data.tokens) {
                            usage = {
                                inputTokens: data.tokens.input ?? 0,
                                outputTokens: data.tokens.output ?? 0,
                                ...(data.tokens.reasoning ? { reasoningTokens: data.tokens.reasoning } : {}),
                                ...(data.tokens.cache?.read ? { cacheReadTokens: data.tokens.cache.read } : {}),
                            };
                        }
                        break outer;
                    }
                    else if (event.type === 'session.error' || event.type === 'session.step.failed') {
                        const message = data.error?.message ?? data.message ?? 'local OpenCode reported an error';
                        throw new LlmError(String(message), 'PROVIDER_STREAM_ERROR');
                    }
                }
            }
            eventsAbort.abort();
            signal?.removeEventListener('abort', onAbort);

            // Prose held back as a possible fence prefix is real text only if no
            // envelope ever opened.
            const tail = detector.flush();
            if (tail) {
                if (open?.kind !== 'text') {
                    yield* closeBlock();
                    yield { type: 'block-start', index: blockIndex, blockType: 'text' };
                    open = { index: blockIndex, kind: 'text', text: '' };
                    blockIndex++;
                    outputStarted = true;
                }
                open.text += tail;
                yield { type: 'text-delta', index: open.index, text: tail };
            }
            const unterminated = detector.flushEnvelope();
            if (unterminated) pendingCalls.push(...parseToolCalls(unterminated));

            yield* closeBlock();

            if (usage) yield { type: 'usage', usage };

            // Tool calls are emitted only after their batch is complete, so a partial
            // envelope can never reach DSH dispatch.
            for (const call of pendingCalls) {
                const id = `call_${blockIndex}_${call.name}`.slice(0, 64);
                yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' };
                yield { type: 'tool-call-delta', index: blockIndex, id, name: call.name, argumentsDelta: call.arguments };
                yield {
                    type: 'block-end',
                    index: blockIndex,
                    block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
                };
                blockIndex++;
                outputStarted = true;
            }

            yield {
                type: 'finish',
                reason: pendingCalls.length
                    ? { kind: 'tool-calls' }
                    : { kind: finishKind ?? 'stop' },
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (open) yield* closeBlock();
            if (options.signal?.aborted) {
                yield { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } };
                return;
            }
            const code = error instanceof LlmError ? error.failure.code : errorCodeFor(error);
            const failure = outputStarted && code !== 'ABORTED'
                ? { message, code: 'PARTIAL_STREAM_ERROR' }
                : { message, code };
            this.logger.error('adapter', 'stream failed', { model: modelId, code, outputStarted });
            yield { type: 'finish', reason: { kind: 'error', failure } };
        }
    }
}
