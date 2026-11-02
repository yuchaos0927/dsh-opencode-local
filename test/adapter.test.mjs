/**
 * Adapter behaviour tests.
 *
 * The adapter is where "the plugin is lazy" must become "the plugin still
 * works": nothing starts at Harness boot, but the first model listing or call
 * must bring the local service up and use it.
 *
 * Run: node --import ./test/loader.mjs --test test/adapter.test.mjs
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

register('./loader.mjs', import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const { LocalOpenCodeAdapter } = await import(join(here, '..', 'lib', 'local-adapter.js'));
const { LocalOpenCodeService } = await import(join(here, '..', 'lib', 'local-service.js'));

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Fake CLI that serves the two endpoints the adapter reads. */
function fakeCli(port, models) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-local-adapter-'));
    const path = join(dir, 'opencode-cli');
    const body = `
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const models = ${JSON.stringify(models)};
const routes = {
  '/api/info': () => ({ ok: true }),
  '/api/model': () => ({ data: models }),
};
http.createServer((req, res) => {
  const handler = routes[req.url.split('?')[0]];
  if (!handler) { res.writeHead(404); res.end(); return; }
  const payload = JSON.stringify(handler());
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}).listen(port, '127.0.0.1', () => {
  console.log('server listening on http://127.0.0.1:' + port);
  console.log('server password pw-adapter');
});
`;
    writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(path, 0o755);
    return { dir, path };
}

const MODELS = [
    { id: 'model-b', name: 'Model B', limit: { context: 131072, output: 8192 } },
    { id: 'model-a', name: 'Model A', limit: { context: 65536, output: 4096 } },
];

test('listing models starts the service on demand and normalizes the catalog', async (t) => {
    const port = 49000 + Math.floor(Math.random() * 500);
    const cli = fakeCli(port, MODELS);
    t.after(() => rmSync(cli.dir, { recursive: true, force: true }));

    const service = new LocalOpenCodeService({ binary: cli.path, port, logger: quiet });
    t.after(() => service.stop());

    // Nothing has touched the service yet.
    assert.equal(service.running, false);

    const adapter = new LocalOpenCodeAdapter(service, {
        models: {
            async list() {
                const ready = await service.start();
                const response = await fetch(`${ready.origin}/api/model`, { headers: ready.headers() });
                const body = await response.json();
                return body.data
                    .map((row) => ({
                        id: row.id,
                        name: row.name,
                        contextWindow: row.limit.context,
                        maxOutputTokens: row.limit.output,
                    }))
                    .sort((a, b) => a.id.localeCompare(b.id));
            },
        },
        logger: quiet,
    });

    const models = await adapter.listModels('opencode-local');
    assert.equal(service.running, true, 'the first listing must start the service');
    assert.deepEqual(models.map((m) => m.id), ['model-a', 'model-b']);
    assert.equal(models[0].provider, 'opencode-local');
    assert.equal(models[0].name, 'Model A');
});

test('resolving an unknown model still yields a usable descriptor', async (t) => {
    const port = 49500 + Math.floor(Math.random() * 400);
    const cli = fakeCli(port, MODELS);
    t.after(() => rmSync(cli.dir, { recursive: true, force: true }));

    const service = new LocalOpenCodeService({ binary: cli.path, port, logger: quiet });
    t.after(() => service.stop());

    const adapter = new LocalOpenCodeAdapter(service, { models: { async list() { return []; } }, logger: quiet });
    const info = await adapter.resolveModel('opencode-local', 'not-in-catalog');
    assert.equal(info.id, 'not-in-catalog');
    assert.equal(info.provider, 'opencode-local');
});

test('the provider descriptor is what the picker shows', () => {
    const adapter = new LocalOpenCodeAdapter({ start: async () => { throw new Error('unused'); } }, {
        models: { async list() { return []; } },
        logger: quiet,
    });
    const info = adapter.providerInfo('opencode-local');
    assert.equal(info.id, 'opencode-local');
    assert.equal(info.name, 'OpenCode');
});
