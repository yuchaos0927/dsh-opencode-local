/**
 * dsh-opencode-local: use this machine's OpenCode models in DeepSeek Harness.
 *
 * The opencode.ai free tier only answers requests made by the OpenCode client
 * itself — other harnesses get `FreeUsageLimitError` even with valid
 * credentials. Rather than impersonating that client over the network, this
 * plugin reuses the real client already installed on the machine: it runs
 * `opencode serve` on a loopback port and talks to that. Nothing is spoofed and
 * nothing leaves 127.0.0.1.
 *
 * Licensed MIT. The logging module derives from an earlier MIT project; the
 * rest of this plugin — local service lifecycle, the prompt-level tool
 * protocol, and the LLM adapter — is its own code.
 */
import Schema from '@deepseek-ai/schemastery';
import { LocalOpenCodeService, findCliBinary } from './local-service.js';
import { LocalOpenCodeAdapter } from './local-adapter.js';
import { PluginLogger, defaultLogDir, noopLogger } from './logger.js';

export { LocalOpenCodeService, findCliBinary } from './local-service.js';
export { LocalOpenCodeAdapter } from './local-adapter.js';
export { PluginLogger, defaultLogDir } from './logger.js';

export const Config = Schema.object({
    /** Provider ids this plugin answers for. Changing it breaks any saved model choice. */
    providers: Schema.array(Schema.string()).default(['opencode-local']),
    /** Explicit CLI path; empty means auto-discover the newest installed build. */
    cliPath: Schema.string().default(''),
    /** Loopback port; 0 lets the OS pick a free one. */
    port: Schema.number().min(0).max(65535).step(1).default(0),
    /** Working directory reported to the local service. */
    directory: Schema.string().default(''),
    /**
     * Keep OpenCode's own tools from executing. On by default: they run inside
     * the OpenCode process, outside Harness approval. Turning this off restores
     * the old behaviour where the model could shell out on its own.
     */
    toolGate: Schema.boolean().default(true),
    /**
     * Hand OpenCode's own tool calls to DSH instead of dropping them. On by
     * default: it is what makes the gate cheap rather than merely safe.
     */
    nativeToolBridge: Schema.boolean().default(true),
    /** How long the discovered model list is reused before asking the service again. */
    modelRefreshIntervalMs: Schema.number().min(0).default(600_000),
    logLevel: Schema.string().default('warn'),
    logDir: Schema.string().default(''),
    logMaxBytes: Schema.number().default(512 * 1024),
    logMaxFiles: Schema.number().default(5),
});

export const name = 'dsh-opencode-local';
export const inject = ['llm'];

const LEVELS = ['debug', 'info', 'warn', 'error', 'off'];
const DEFAULT_PROVIDER = 'opencode-local';

/**
 * Coerce the resolved config into values this module can trust.
 *
 * The plugin must behave even when the Host hands it a partial, stale, or
 * unexpected config object: a throw here would run during Harness startup,
 * which is exactly where a third-party plugin must never be able to hurt.
 */
function normalizeConfig(config) {
    const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    const providers = Array.isArray(raw.providers)
        ? raw.providers.filter((id) => typeof id === 'string' && id.length > 0)
        : [];
    const nonNegative = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
    return {
        providers: providers.length > 0 ? providers : [DEFAULT_PROVIDER],
        cliPath: typeof raw.cliPath === 'string' ? raw.cliPath : '',
        port: Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= 65535 ? raw.port : 0,
        directory: typeof raw.directory === 'string' ? raw.directory : '',
        toolGate: raw.toolGate !== false,
        nativeToolBridge: raw.nativeToolBridge !== false,
        modelRefreshIntervalMs: nonNegative(raw.modelRefreshIntervalMs, 600_000),
        logLevel: LEVELS.includes(raw.logLevel) ? raw.logLevel : 'warn',
        logDir: typeof raw.logDir === 'string' ? raw.logDir : '',
        logMaxBytes: nonNegative(raw.logMaxBytes, 512 * 1024),
        logMaxFiles: Number.isInteger(raw.logMaxFiles) && raw.logMaxFiles > 0 ? raw.logMaxFiles : 5,
    };
}

/** Read the chat models the local service advertises. */
async function fetchModels(service) {
    const ready = await service.start();
    const response = await fetch(`${ready.origin}/api/model`, {
        headers: ready.headers(),
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`local model listing HTTP ${response.status}`);
    }
    const body = await response.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows
        .filter((row) => row && typeof row.id === 'string')
        .map((row) => ({
            id: row.id,
            name: typeof row.name === 'string' ? row.name : row.id,
            ...(typeof row.limit?.context === 'number' ? { contextWindow: row.limit.context } : {}),
            ...(typeof row.limit?.output === 'number' ? { maxOutputTokens: row.limit.output } : {}),
            ...(Array.isArray(row.modalities?.input)
                ? { inputModalities: row.modalities.input.filter((m) => m === 'text' || m === 'image') }
                : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

/** Small cache so the model picker does not spawn a request per keystroke. */
function createModelSource(service, options, logger) {
    let cached;
    let fetchedAt = 0;
    const ttl = Math.max(30_000, options.refreshIntervalMs ?? 600_000);
    return {
        async list() {
            const now = Date.now();
            if (cached && now - fetchedAt < ttl) return cached;
            try {
                const models = await fetchModels(service);
                if (models.length > 0) {
                    cached = models;
                    fetchedAt = now;
                }
                return cached ?? models;
            }
            catch (error) {
                // A transient failure must not empty the picker; keep the last good list.
                logger.warn('catalog', 'refresh failed', { error: String(error) });
                if (cached) return cached;
                throw error;
            }
        },
    };
}

function safeFindCli(logger) {
    try {
        return findCliBinary();
    }
    catch (error) {
        logger.warn('plugin', 'CLI discovery failed', { error: String(error) });
        return undefined;
    }
}

/**
 * Register everything this plugin contributes, and nothing more.
 *
 * Deliberately does NOT start `opencode serve`. Spawning a child process while
 * the Harness itself is still booting puts an external binary — one this plugin
 * does not control — on the startup critical path, where a slow or failing
 * child delays or breaks the Harness. The service starts on first use instead
 * (both the adapter and the model source call `start()`), which is the moment a
 * user actually asked for one of these models.
 */
function setup(ctx, options, logger) {
    const binary = options.cliPath || safeFindCli(logger);
    logger.info('plugin', 'starting', { binary: binary ?? '(not found)', port: options.port || 'auto' });

    const service = new LocalOpenCodeService({
        binary: binary || undefined,
        port: options.port || undefined,
        ...(options.toolGate ? {} : { toolGate: false }),
        logger,
    });
    const models = createModelSource(service, { refreshIntervalMs: options.modelRefreshIntervalMs }, logger);

    const adapter = new LocalOpenCodeAdapter(service, {
        models,
        logger,
        directory: options.directory || undefined,
        nativeToolBridge: options.nativeToolBridge !== false,
    });

    const providers = [...options.providers];

    // Registration first: without it nothing can ever call this adapter, so a
    // failure here must leave no process, no timers, and no half-wired state.
    let registration;
    try {
        registration = ctx.llm.registerAdapter(providers, adapter);
        logger.info('plugin', 'LLM adapter registered', { providers: providers.join(',') });
    }
    catch (error) {
        // A hot reload can apply this plugin again while the previous adapter is
        // still registered. The live registration is the one serving requests, so
        // treat the duplicate as "already live" and stay inert rather than
        // failing the Harness or leaking a second child process.
        const message = String(error);
        if (/already registered/.test(message) || error?.code === 'DUPLICATE_ADAPTER') {
            logger.warn('plugin', 'adapter already registered; keeping the live registration', { providers: providers.join(',') });
        }
        else {
            logger.error('plugin', 'failed to register LLM adapter; plugin inert', { error: message });
        }
        return;
    }

    const disposers = [];
    const track = (handle) => {
        if (typeof handle === 'function') disposers.push(handle);
    };

    try {
        track(ctx.llm.registerConfigurableProviders(providers.map((provider) => ({
            provider,
            displayName: 'OpenCode',
            settingsNs: 'opencode-local',
            settingsPath: [],
        }))));
    }
    catch (error) {
        logger.warn('plugin', 'registerConfigurableProviders skipped', { error: String(error) });
    }

    try {
        track(ctx.llm.registerModelDiscovery('opencode-local', async () => {
            const list = await models.list();
            return list.map((model) => ({
                id: model.id,
                name: model.name,
                ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
                ...(model.maxOutputTokens ? { maxTokens: model.maxOutputTokens } : {}),
            }));
        }));
    }
    catch (error) {
        logger.warn('plugin', 'registerModelDiscovery skipped', { error: String(error) });
    }

    // Own the child process: whatever happens, it must be reaped on unload. A
    // leaked `opencode serve` would hold a port and an account session after
    // DSH exits. Nothing is started here — see this function's doc comment.
    ctx.effect(() => () => {
        for (const dispose of disposers.reverse()) {
            try { dispose(); } catch { /* disposal is best-effort */ }
        }
        try { registration?.(); } catch { /* already gone */ }
        try { service.stop(); } catch { /* already gone */ }
    });
}

export function apply(ctx, config) {
    let logger;
    try {
        const options = normalizeConfig(config);
        logger = new PluginLogger({
            level: options.logLevel,
            dir: options.logDir || defaultLogDir(),
            maxBytes: options.logMaxBytes,
            maxFiles: options.logMaxFiles,
        });
        setup(ctx, options, logger);
    }
    catch (error) {
        // A third-party plugin must never take the Harness down with it — not at
        // boot, and not during a settings projection that enumerates every plugin.
        try {
            (logger ?? noopLogger).error('plugin', 'setup failed; plugin inert', { error: String(error) });
        }
        catch { /* logging is best-effort */ }
    }
}
