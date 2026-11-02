/**
 * Local service lifecycle tests.
 *
 * The plugin's whole job is to own one `opencode serve` child process. The
 * things that can go wrong here are the ones users actually notice: a process
 * that never starts, a process that is never reaped, or a died process that the
 * plugin keeps trusting.
 *
 * These tests drive the real `LocalOpenCodeService` against a fake CLI, so no
 * OpenCode installation is required.
 *
 * Run: node --test test/local-service.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const { LocalOpenCodeService } = await import(join(here, '..', 'lib', 'local-service.js'));

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Write an executable fake CLI that behaves the way the plugin expects. */
function fakeCli(body) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-local-test-'));
    const path = join(dir, 'opencode-cli');
    writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(path, 0o755);
    return { dir, path };
}

test('a missing binary fails with a clear message instead of hanging', async () => {
    const service = new LocalOpenCodeService({ binary: '/nonexistent/opencode-cli', logger: quiet });
    await assert.rejects(() => service.start(), /ENOENT|not found/i);
    service.stop();
});

test('start() reads the printed password and reports a usable origin', async (t) => {
    const port = 45000 + Math.floor(Math.random() * 1000);
    const cli = fakeCli(`
const net = require('node:net');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = net.createServer((socket) => {
  socket.on('data', () => {
    socket.end('HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\n\\r\\nok');
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log('server listening on http://127.0.0.1:' + port);
  console.log('server password test-password-123');
});
`);
    t.after(() => rmSync(cli.dir, { recursive: true, force: true }));

    const service = new LocalOpenCodeService({ binary: cli.path, port, logger: quiet });
    t.after(() => service.stop());

    const ready = await service.start();
    assert.equal(ready.origin, `http://127.0.0.1:${port}`);
    assert.equal(service.running, true);
    assert.match(ready.headers().authorization, /^Basic /);
});

test('concurrent start() calls share one launch', async (t) => {
    const port = 46000 + Math.floor(Math.random() * 1000);
    const cli = fakeCli(`
const net = require('node:net');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = net.createServer((socket) => {
  socket.on('data', () => socket.end('HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\n\\r\\nok'));
});
server.listen(port, '127.0.0.1', () => {
  console.log('server password pw-concurrent');
});
`);
    t.after(() => rmSync(cli.dir, { recursive: true, force: true }));

    const service = new LocalOpenCodeService({ binary: cli.path, port, logger: quiet });
    t.after(() => service.stop());

    const results = await Promise.all([service.start(), service.start(), service.start()]);
    assert.equal(new Set(results.map((r) => r.origin)).size, 1);
});

test('stop() reaps the child and clears the handle', async (t) => {
    const port = 47000 + Math.floor(Math.random() * 1000);
    const cli = fakeCli(`
const net = require('node:net');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = net.createServer((socket) => {
  socket.on('data', () => socket.end('HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\n\\r\\nok'));
});
server.listen(port, '127.0.0.1', () => console.log('server password pw-stop'));
`);
    t.after(() => rmSync(cli.dir, { recursive: true, force: true }));

    const service = new LocalOpenCodeService({ binary: cli.path, port, logger: quiet });
    await service.start();
    const pid = service.child.pid;
    assert.ok(pid > 0);

    service.stop();
    assert.equal(service.running, false);
    assert.equal(service.origin, undefined);

    // The process must actually go away, not merely be forgotten.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(existsSync(`/proc/${pid}`) && process.platform === 'linux', false);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, 'child process was not reaped');
});

test('stop() is safe when the service never started', () => {
    const service = new LocalOpenCodeService({ binary: '/nonexistent', logger: quiet });
    assert.doesNotThrow(() => service.stop());
    assert.doesNotThrow(() => service.stop());
});

test('a child that dies during startup rejects instead of reporting ready', async (t) => {
    const cli = fakeCli(`process.stderr.write('boom\\n'); process.exit(130);`);
    t.after(() => rmSync(cli.dir, { recursive: true, force: true }));

    const service = new LocalOpenCodeService({ binary: cli.path, port: 48000 + Math.floor(Math.random() * 1000), logger: quiet });
    t.after(() => service.stop());

    await assert.rejects(() => service.start(), /exited during startup|code 130/i);
    assert.equal(service.running, false);
});
