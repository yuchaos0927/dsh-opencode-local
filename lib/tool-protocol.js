/**
 * Prompt-level function calling.
 *
 * The local OpenCode service is a complete agent: it owns tool declarations and
 * executes them itself. It exposes no way to hand it an external tool list, and
 * `dsh-llm` has no "provider already executed this" block type — so we cannot
 * simply forward its tool events to DSH.
 *
 * Instead we keep OpenCode as a *pure model backend*: the DSH tool schemas are
 * rendered into the prompt, the model is asked to answer with a single fenced
 * JSON envelope when it wants a tool, and this module turns that envelope back
 * into native DSH `tool-call` blocks. DSH then executes the tool itself, so its
 * permissions, approvals, and skills stay in charge.
 *
 * Trade-off, stated plainly: this relies on instruction-following rather than a
 * protocol-level tool channel. Strong models comply reliably; weak ones may need
 * the retry that the adapter provides.
 */

/** Marker the model must use so we do not treat ordinary JSON as a call. */
export const TOOL_OPEN = '```dsh-tool';
export const TOOL_CLOSE = '```';

/**
 * Render the DSH tool catalog into prompt text.
 *
 * Only names, descriptions, and JSON Schemas are emitted. Nothing from the
 * user's conversation is copied here.
 */
export function renderToolProtocol(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';

    const catalog = tools.map((tool) => ({
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
    }));

    return [
        '## Tool calling protocol',
        '',
        'You are the reasoning engine of an external agent runtime. That runtime, not you,',
        'executes tools and feeds you the results on the next turn.',
        '',
        'The tools currently available are:',
        '',
        '```json',
        JSON.stringify(catalog, null, 2),
        '```',
        '',
        'Rules:',
        `1. To call one or more tools, reply with ONLY a fenced block opened by ${TOOL_OPEN} and closed by ${TOOL_CLOSE}, containing a JSON array of calls.`,
        '2. Each call is {"name": "<tool name>", "arguments": { ... }}. Arguments MUST match that tool\'s schema.',
        '3. Emit no prose outside the fenced block when you call tools.',
        '4. If no tool is needed, answer normally in plain text with no fence.',
        '5. Never claim you ran a tool. You cannot run tools; the runtime does.',
        '',
        'Example response when calling a tool:',
        '',
        TOOL_OPEN,
        '[{"name":"read","arguments":{"path":"/etc/hosts"}}]',
        TOOL_CLOSE,
    ].join('\n');
}

/**
 * Incremental reader for the tool envelope.
 *
 * Text arrives in arbitrary chunks, so the fence can straddle deltas. This
 * buffer holds back only the bytes that might still become a fence opener,
 * which keeps normal prose streaming live instead of waiting for the turn to end.
 */
export class ToolFenceDetector {
    /** Text seen so far that has not been emitted as prose yet. */
    pending = '';
    /** True once an opener was matched; everything after it is envelope content. */
    inEnvelope = false;
    /** Accumulated envelope body (the JSON between the fences). */
    body = '';

    /**
     * Feed one delta.
     * @returns prose to emit now (may be empty) and whether an envelope opened.
     */
    push(delta) {
        let prose = '';
        let opened = null;

        if (this.inEnvelope) {
            this.body += delta;
            const close = this.body.indexOf(TOOL_CLOSE);
            if (close !== -1) {
                const json = this.body.slice(0, close);
                this.body = '';
                this.inEnvelope = false;
                opened = json;
            }
            return { prose, opened };
        }

        this.pending += delta;
        const index = this.pending.indexOf(TOOL_OPEN);
        if (index === -1) {
            // No opener yet. Hold back only a trailing partial marker.
            const keep = longestMarkerSuffix(this.pending, TOOL_OPEN);
            prose = this.pending.slice(0, this.pending.length - keep);
            this.pending = this.pending.slice(this.pending.length - keep);
            return { prose, opened };
        }

        prose = this.pending.slice(0, index);
        this.body = this.pending.slice(index + TOOL_OPEN.length);
        this.pending = '';
        this.inEnvelope = true;

        const close = this.body.indexOf(TOOL_CLOSE);
        if (close !== -1) {
            const json = this.body.slice(0, close);
            this.body = '';
            this.inEnvelope = false;
            opened = json;
        }
        return { prose, opened };
    }

    /** Remaining prose when the turn ended and no envelope ever opened. */
    flush() {
        if (this.inEnvelope) return '';
        const rest = this.pending;
        this.pending = '';
        return rest;
    }

    /** Envelope body left unterminated at end of turn, if any. */
    flushEnvelope() {
        return this.inEnvelope ? this.body : '';
    }
}

/** Length of the longest suffix of `text` that is a prefix of `marker`. */
function longestMarkerSuffix(text, marker) {
    const max = Math.min(text.length, marker.length - 1);
    for (let length = max; length > 0; length--) {
        if (text.endsWith(marker.slice(0, length))) return length;
    }
    return 0;
}

/**
 * Parse the envelope body into tool calls.
 *
 * Returns an empty array for malformed JSON rather than throwing: a model that
 * fumbles the format should degrade to plain text, not fail the turn.
 */
export function parseToolCalls(json) {
    if (typeof json !== 'string' || json.trim().length === 0) return [];
    let value;
    try {
        value = JSON.parse(json.trim());
    }
    catch {
        return [];
    }
    const list = Array.isArray(value) ? value : [value];
    const calls = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const name = item.name;
        if (typeof name !== 'string' || name.length === 0) continue;
        const args = item.arguments ?? item.input ?? {};
        calls.push({
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
        });
    }
    return calls;
}

/**
 * Render prior tool results into the transcript the model reads.
 *
 * DSH history carries `role: 'tool'` turns keyed by call id; the model needs to
 * see them inline so it can continue after a tool ran.
 */
export function renderToolResult(message) {
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
        .map((part) => {
            if (part?.type === 'text') return part.text;
            if (part?.type === 'image') return '[image attached]';
            if (part?.type === 'file') return '[file attached]';
            return '';
        })
        .filter(Boolean)
        .join('\n');
    return text || '(no output)';
}
