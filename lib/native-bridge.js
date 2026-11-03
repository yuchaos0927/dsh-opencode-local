/**
 * Bridge OpenCode's native tool calls into DSH tool calls.
 *
 * The permission gate (see `tool-gate.js`) stops OpenCode from executing tools,
 * but stopping it is not the same as using it: the model still spends a step
 * producing a call that is thrown away, and a measured turn spent three of them
 * before switching to the `dsh-tool` envelope. This module recovers those calls
 * instead of discarding them.
 *
 * The mapping is schema-driven rather than hand-written. DSH tool schemas name
 * their arguments differently from OpenCode's (`file_path` vs `filePath`), and
 * those names change between releases, so a hardcoded table would rot silently:
 * the call would be forwarded with an argument the tool never reads and the
 * failure would surface as an empty result far from its cause. Instead the
 * native argument keys are matched against the *target tool's own* declared
 * properties, and a required property that cannot be filled rejects the bridge.
 *
 * Rejecting the bridge is always safe: the caller falls back to the permission
 * gate, which is the pre-0.4 behaviour.
 */

/**
 * OpenCode tool name -> DSH tool name.
 *
 * Only tools whose meaning is the same on both sides are listed. Deliberately
 * absent: `task` (OpenCode spawns its own subagent — DSH's subagent tool has
 * different semantics and its own catalog), `patch` (a whole-diff apply with no
 * DSH equivalent), and `list` (a directory listing; DSH has no such tool, and
 * routing it to glob would invent a pattern the model never asked for).
 */
const NAME_MAP = {
    shell: 'bash',
    bash: 'bash',
    read: 'read',
    write: 'write',
    edit: 'edit',
    glob: 'glob',
    grep: 'grep',
    webfetch: 'web_fetch',
    websearch: 'web_search',
    todowrite: 'todo_write',
};

/** `filePath`, `file_path` and `FILEPATH` are the same slot in different dialects. */
function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Properties declared by a tool's JSON schema. */
function schemaProperties(tool) {
    const properties = tool?.parameters?.properties;
    return properties && typeof properties === 'object' ? properties : {};
}

function schemaRequired(tool) {
    const required = tool?.parameters?.required;
    return Array.isArray(required) ? required : [];
}

/**
 * Fill a required argument the model did not send but that can be derived.
 *
 * `bash` is the one case worth deriving: DSH requires a human-readable
 * `description` for every shell command, OpenCode does not ask for one, and the
 * command itself is a truthful label. Anything else is left unfilled so the
 * caller falls back rather than inventing a value.
 */
function deriveArgument(toolName, property, nativeInput) {
    if (toolName === 'bash' && property === 'description') {
        const command = nativeInput.command;
        if (typeof command === 'string' && command.trim()) {
            return command.trim().split('\n')[0].slice(0, 120);
        }
    }
    // DSH searches several queries at once; OpenCode's tool takes a single
    // `query`. Wrapping one string in an array is the same request, not a guess.
    if (toolName === 'web_search' && property === 'queries') {
        const single = nativeInput.query ?? nativeInput.q;
        if (typeof single === 'string' && single.trim()) return [single.trim()];
    }
    return undefined;
}

/**
 * Translate one native call into a DSH call.
 *
 * @param {{name?: string, input?: unknown}} nativeCall  the `session.tool.called` payload
 * @param {Array<{name: string, parameters?: object}>} tools  the DSH tools offered this turn
 * @returns {{name: string, arguments: string} | null} null when the call cannot be
 *   represented honestly, in which case the caller keeps the permission gate.
 */
export function bridgeNativeCall(nativeCall, tools) {
    const nativeName = typeof nativeCall?.name === 'string' ? nativeCall.name : '';
    const targetName = NAME_MAP[normalizeNativeName(nativeName)];
    if (!targetName) return null;

    const catalog = Array.isArray(tools) ? tools : [];
    const target = catalog.find((tool) => tool?.name === targetName);
    // The tool may simply not be offered in this turn (the user disabled it, a
    // permission rule removed it). Forwarding it anyway would call something DSH
    // will not dispatch.
    if (!target) return null;

    const input = nativeCall?.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

    const properties = schemaProperties(target);
    const declared = Object.keys(properties);
    if (declared.length === 0) return null;

    // Index the native arguments by their normalized key so a dialect change
    // cannot make an argument silently disappear.
    const byNormalizedKey = new Map();
    for (const [key, value] of Object.entries(input)) {
        byNormalizedKey.set(normalizeKey(key), value);
    }

    const args = {};
    for (const property of declared) {
        const value = byNormalizedKey.get(normalizeKey(property));
        if (value !== undefined) {
            args[property] = value;
            continue;
        }
        const derived = deriveArgument(targetName, property, input);
        if (derived !== undefined) args[property] = derived;
    }

    for (const required of schemaRequired(target)) {
        if (args[required] === undefined) return null;
    }

    return { name: targetName, arguments: JSON.stringify(args) };
}

/** Lowercase, so `Shell` and `shell` are the same tool. */
function normalizeNativeName(name) {
    return String(name).toLowerCase();
}

/** Names this module knows how to translate, for diagnostics and tests. */
export function bridgedToolNames() {
    return { ...NAME_MAP };
}
