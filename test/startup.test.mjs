/**
 * Startup-safety tests for dsh-opencode-local.
 *
 * A third-party Harness plugin runs inside the Host's own boot. Anything that
 * throws from `apply()`, or that puts an external process on the startup
 * critical path, can take the whole application down before a window appears.
 * These tests pin that boundary:
 *
 *   - `apply()` never throws, whatever config it is handed
 *   - `apply()` starts no child process and opens no socket
 *   - a duplicate adapter registration stays inert instead of half-wiring
 *   - disposal releases every registration it made
 *
 * Run: node --import ./test/loader.mjs --test test/startup.test.mjs
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./loader.mjs', import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'lib', 'index.js');
const { apply } = await import(entry);

/** Minimal stand-in for the Cordis context surface this plugin touches. */
function makeContext(overrides = {}) {
    const calls = [];
    const disposers = [];
    const ctx = {
        calls,
        llm: {
            registerAdapter(providers) {
                calls.push(['registerAdapter', [...providers].join(',')]);
                const handle = () => calls.push(['disposeAdapter']);
                handle.replace = () => {};
                return handle;
            },
            registerConfigurableProviders(entries) {
                calls.push(['registerConfigurableProviders', entries.length]);
                return () => calls.push(['disposeConfigurable']);
            },
            registerModelDiscovery(namespace) {
                calls.push(['registerModelDiscovery', namespace]);
                return () => calls.push(['disposeDiscovery']);
            },
            ...overrides.llm,
        },
        effect(callback) {
            calls.push(['effect']);
            disposers.push(callback());
        },
        runDispose() {
            for (const dispose of disposers) dispose();
        },
    };
    return ctx;
}

test('apply() tolerates a missing config object', () => {
    const ctx = makeContext();
    assert.doesNotThrow(() => apply(ctx, undefined));
    assert.deepEqual(ctx.calls[0], ['registerAdapter', 'opencode-local']);
});

test('apply() tolerates malformed config values', () => {
    const ctx = makeContext();
    const junk = { providers: 'nope', port: -5, logLevel: 42, logMaxFiles: 'x', logMaxBytes: null };
    assert.doesNotThrow(() => apply(ctx, junk));
    assert.deepEqual(ctx.calls[0], ['registerAdapter', 'opencode-local']);
});

test('apply() falls back to the default provider when the list is empty', () => {
    const ctx = makeContext();
    apply(ctx, { providers: [] });
    assert.deepEqual(ctx.calls[0], ['registerAdapter', 'opencode-local']);
});

test('apply() registers a cleanup effect but starts nothing eagerly', () => {
    const ctx = makeContext();
    apply(ctx, {});
    // Exactly one effect: the disposer. Its callback must NOT have started the service.
    assert.equal(ctx.calls.filter(([name]) => name === 'effect').length, 1);
    assert.equal(ctx.calls.some(([name]) => name === 'startService'), false);
});

test('apply() opens no socket and spawns no child during setup', () => {
    const ctx = makeContext();
    const before = ctx.calls.length;
    apply(ctx, {});
    const during = ctx.calls.slice(before).map(([name]) => name);
    // Only registration calls are allowed; anything process-shaped is a regression.
    assert.deepEqual(during, ['registerAdapter', 'registerConfigurableProviders', 'registerModelDiscovery', 'effect']);
});

test('a duplicate adapter registration leaves the plugin inert', () => {
    const ctx = makeContext({
        llm: {
            registerAdapter() {
                const error = new Error('an adapter for provider "opencode-local" is already registered');
                error.code = 'DUPLICATE_ADAPTER';
                throw error;
            },
        },
    });
    assert.doesNotThrow(() => apply(ctx, {}));
    // It must not register the directory or discovery while it cannot serve calls.
    assert.deepEqual(ctx.calls.filter(([name]) => name !== 'effect'), []);
});

test('disposal releases every registration the plugin made', () => {
    const ctx = makeContext();
    apply(ctx, {});
    // Three registrations plus the cleanup effect; only the first three are disposable handles.
    assert.equal(ctx.calls.filter(([name]) => name === 'registerAdapter').length, 1);
    assert.equal(ctx.calls.filter(([name]) => name === 'registerConfigurableProviders').length, 1);
    assert.equal(ctx.calls.filter(([name]) => name === 'registerModelDiscovery').length, 1);

    ctx.runDispose();
    const disposed = ctx.calls.filter(([name]) => String(name).startsWith('dispose')).map(([name]) => name);
    assert.deepEqual(disposed.sort(), ['disposeAdapter', 'disposeConfigurable', 'disposeDiscovery']);
});

test('apply() contains an unexpected llm-service failure instead of throwing', () => {
    const ctx = makeContext({
        llm: {
            registerAdapter() {
                throw new TypeError('host exploded');
            },
        },
    });
    assert.doesNotThrow(() => apply(ctx, {}));
});

test('the module exports a Config schema the settings surface can project', async () => {
    const module = await import(entry);
    assert.equal(typeof module.Config?.toJSON, 'function');
    const json = module.Config.toJSON();
    // Real shape: a node table whose root entry is the object schema.
    assert.equal(typeof json.uid, 'number');
    const root = json.refs[json.uid];
    assert.equal(root.type, 'object');
    assert.ok(root.dict && typeof root.dict === 'object');
    // Every declared field must survive projection, or the settings page loses it.
    for (const field of [
        'providers', 'cliPath', 'port', 'directory',
        'modelRefreshIntervalMs', 'logLevel', 'logDir', 'logMaxBytes', 'logMaxFiles',
    ]) {
        assert.ok(root.dict[field], `Config is missing field: ${field}`);
    }
});

/**
 * The plugin must not spawn its child process from `apply()`. This is a source
 * check because the behaviour is "absence of a call", which a unit test of the
 * exports cannot observe once the process is gone.
 */
test('the entry module never starts the service eagerly', () => {
    const source = readFileSync(entry, 'utf8');
    assert.equal(/void\s+service\.start\(/.test(source), false, 'apply() must not autostart opencode serve');
    assert.equal(/service\.start\(\)\s*\.catch/.test(source), false);
});

test('only the intended source files ship in lib', () => {
    const files = readdirSync(join(here, '..', 'lib')).filter((name) => name.endsWith('.js')).sort();
    assert.deepEqual(files, ['index.js', 'local-adapter.js', 'local-service.js', 'logger.js', 'tool-gate.js', 'tool-protocol.js']);
});
