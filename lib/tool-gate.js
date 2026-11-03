/**
 * Tool gate: keep OpenCode from running tools of its own.
 *
 * OpenCode is a complete agent — it declares its own tools (shell, read, edit,
 * ...) and executes them inside its process, where the Harness cannot see them,
 * approve them, or undo them. This plugin only wants the *model*, so those tools
 * must never run.
 *
 * Two failed approaches shaped this file:
 *
 *   - Turning tools off entirely (`permissions: deny *`) makes the free tier
 *     reject the request with `FreeUsageLimitError` (HTTP 429). Verified live:
 *     the same model answers with tools declared and is refused without them.
 *   - Leaving tools at `allow` lets the model call them, and OpenCode runs them
 *     against the real filesystem with no Harness approval.
 *
 * What works is the middle setting: `ask`. Tools stay *declared*, so the free
 * tier serves the request, but every call stops at a permission gate before it
 * executes. The adapter rejects each request with a message that points the
 * model back at the prompt-level `dsh-tool` protocol, which is the only channel
 * where the Harness owns execution.
 *
 * The agent is defined in a config file this plugin owns (passed to the child
 * via OPENCODE_CONFIG), so nothing is written into the user's OpenCode config.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Id of the private agent. Unlikely to collide with a name a user would pick. */
export const BACKEND_AGENT_ID = 'dsh-backend';

/**
 * How many model steps one turn may take.
 *
 * A rejected tool call costs a step, and the model needs a further step to
 * answer through the `dsh-tool` envelope, so this must be more than one.
 *
 * Measured: the model reaches for a native tool three times before switching to
 * the envelope, so one tool call already spends four steps and a two-tool turn
 * would hit a limit of 6. Costs nothing when unused — every extra step is only
 * taken if a call is refused.
 */
const MAX_STEPS = 30;

/** Message handed to the model when it reaches for a native tool. */
export const REJECTION_MESSAGE = 'Tools cannot be run by you directly. To use a tool, reply with ONLY a fenced block opened by ```dsh-tool containing the JSON array of calls; the runtime will execute it and return the result.';

/**
 * Write the private agent config and return its path.
 *
 * Written per child process so two Harness instances cannot fight over it. The
 * child reads it at startup only, so a stale file is harmless.
 */
export function writeBackendConfig(agentId = BACKEND_AGENT_ID) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-opencode-local-'));
    const configPath = path.join(dir, 'opencode.json');
    const config = {
        agents: {
            [agentId]: {
                description: 'Model backend for DeepSeek Harness; runs no tools of its own.',
                mode: 'primary',
                hidden: true,
                steps: MAX_STEPS,
                permissions: [{ action: '*', resource: '*', effect: 'ask' }],
            },
        },
        default_agent: agentId,
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    return { configPath, dir };
}

/** Remove a config directory; best effort, never throws. */
export function removeBackendConfig(dir) {
    if (!dir) return;
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    catch {
        // A leftover file in the OS temp directory is not worth an error path.
    }
}
