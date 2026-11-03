/**
 * Turn-shape tests for the adapter.
 *
 * The bug these lock down: one user turn can span several OpenCode steps. When
 * the model answers by calling one of OpenCode's own tools, the first step ends
 * with a tool call and the prose arrives in the next step. Ending the DSH turn at
 * the first `session.step.ended` returned reasoning with no answer at all.
 *
 * Run: node --import ./test/loader.mjs --test test/stream.test.mjs
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

register('./loader.mjs', import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const { LocalOpenCodeAdapter } = await import(join(here, '..', 'lib', 'local-adapter.js'));

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Start a fake local service whose prompt endpoint plays back `script`.
 *
 * Each entry is an event body; `sessionID` is filled in by the caller so the
 * tests read like the wire capture they came from.
 */
async function fakeService(script) {
    let subscriber;
    const permissionReplies = [];
    const agentSelections = [];
    const server = http.createServer((req, res) => {
        const url = req.url.split('?')[0];
        if (url === '/api/event') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            // The adapter awaits the response headers before it prompts; without
            // this flush that await and the prompt would wait on each other.
            res.flushHeaders();
            subscriber = res;
            return;
        }
        if (url === '/api/model') {
            const payload = JSON.stringify({ data: [{ id: 'fake-model', name: 'Fake' }] });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(payload);
            return;
        }
        if (url === '/api/session' && req.method === 'POST') {
            req.resume();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: { id: 'ses_test' } }));
            return;
        }
        if (url.endsWith('/permission/' + url.split('/permission/')[1]?.split('/')[0] + '/reply') && url.includes('/permission/')) {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                permissionReplies.push({ url, body });
                res.writeHead(204);
                res.end();
            });
            return;
        }
        if (url.endsWith('/agent')) {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                agentSelections.push(body);
                res.writeHead(204);
                res.end();
            });
            return;
        }
        if (url.endsWith('/model')) {
            req.resume();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
            return;
        }
        if (url.endsWith('/prompt')) {
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ data: { id: 'msg_1' } }));
                // Deliver the scripted events after the POST has been answered,
                // the same order the real service uses.
                setTimeout(() => {
                    for (const event of script) {
                        subscriber?.write(`data: ${JSON.stringify({ type: event.type, data: { sessionID: 'ses_test', ...event.data } })}\n\n`);
                    }
                }, 10);
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const service = { origin, headers: () => ({}), start: async () => service, stop() {} };
    return {
        service,
        permissionReplies,
        agentSelections,
        close: () => { subscriber?.end(); server.close(); },
    };
}

function adapterFor(service) {
    return new LocalOpenCodeAdapter(service, {
        models: { list: async () => [{ id: 'fake-model', name: 'Fake' }] },
        logger: quiet,
        directory: here,
    });
}

async function run(adapter, prompt) {
    const events = [];
    for await (const event of adapter.stream({
        model: 'fake-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: [],
    })) {
        events.push(event);
    }
    return events;
}

test('an answer that follows a tool step is not lost', async () => {
    const { service, close } = await fakeService([
        { type: 'session.step.started', data: { assistantMessageID: 'msg_a' } },
        { type: 'session.tool.called', data: { assistantMessageID: 'msg_a', id: 'call_1', name: 'read', input: { path: '.' } } },
        { type: 'session.tool.success', data: { assistantMessageID: 'msg_a', id: 'call_1', content: [{ type: 'text', text: 'ok' }] } },
        { type: 'session.step.ended', data: { finish: 'tool-calls', tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 50 } } } },
        { type: 'session.step.started', data: { assistantMessageID: 'msg_b' } },
        { type: 'session.reasoning.delta', data: { delta: 'summarising' } },
        { type: 'session.text.delta', data: { delta: 'Hello ' } },
        { type: 'session.text.delta', data: { delta: 'world' } },
        { type: 'session.step.ended', data: { finish: 'stop', tokens: { input: 20, output: 5, reasoning: 3, cache: { read: 30 } } } },
        { type: 'session.execution.succeeded', data: {} },
    ]);

    try {
        const events = await run(adapterFor(service), 'read the directory and summarise it');
        const text = events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('');
        assert.equal(text, 'Hello world');

        const finish = events.find((e) => e.type === 'finish');
        assert.deepEqual(finish.reason, { kind: 'stop' });

        // Both steps must be billed, not just the one that happened to end last.
        const usage = events.find((e) => e.type === 'usage');
        assert.equal(usage.usage.inputTokens, 120);
        assert.equal(usage.usage.outputTokens, 15);
        assert.equal(usage.usage.reasoningTokens, 3);
        assert.equal(usage.usage.cacheReadTokens, 80);
    }
    finally {
        close();
    }
});

test('a turn that never produces an answer fails loudly instead of silently', async () => {
    const { service, close } = await fakeService([
        { type: 'session.step.started', data: { assistantMessageID: 'msg_a' } },
        { type: 'session.tool.called', data: { assistantMessageID: 'msg_a', id: 'call_1', name: 'read', input: { path: '.' } } },
        { type: 'session.step.ended', data: { finish: 'tool-calls', tokens: { input: 10, output: 2 } } },
        { type: 'session.execution.succeeded', data: {} },
    ]);

    try {
        const events = await run(adapterFor(service), 'do something');
        const finish = events.find((e) => e.type === 'finish');
        assert.equal(finish.reason.kind, 'error');
        assert.match(finish.reason.failure.message, /never produced an answer/);
    }
    finally {
        close();
    }
});

test('a failed execution surfaces the provider message', async () => {
    const { service, close } = await fakeService([
        { type: 'session.step.started', data: { assistantMessageID: 'msg_a' } },
        { type: 'session.execution.failed', data: { error: { message: 'free tier exhausted' } } },
    ]);

    try {
        const events = await run(adapterFor(service), 'hello');
        const finish = events.find((e) => e.type === 'finish');
        assert.equal(finish.reason.kind, 'error');
        assert.match(finish.reason.failure.message, /free tier exhausted/);
    }
    finally {
        close();
    }
});


test('native tool calls are refused and the answer still arrives', async () => {
    const { service, permissionReplies, agentSelections, close } = await fakeService([
        { type: 'session.step.started', data: { assistantMessageID: 'msg_a' } },
        { type: 'permission.asked', data: { id: 'per_1', action: 'read', resources: ['.'] } },
        { type: 'session.step.ended', data: { finish: 'tool-calls', tokens: { input: 10, output: 2 } } },
        { type: 'session.step.started', data: { assistantMessageID: 'msg_b' } },
        { type: 'session.text.delta', data: { delta: 'answered without touching the disk' } },
        { type: 'session.step.ended', data: { finish: 'stop', tokens: { input: 5, output: 4 } } },
        { type: 'session.execution.succeeded', data: {} },
    ]);

    try {
        const events = await run(adapterFor(service), 'read the directory');

        const finish = events.find((e) => e.type === 'finish');
        assert.deepEqual(finish.reason, { kind: 'stop' });

        // The private agent must be selected, or the gate is not in force.
        assert.equal(agentSelections.length, 1);
        assert.equal(JSON.parse(agentSelections[0]).agent, 'dsh-backend');

        // Exactly one refusal, and it must be a reject with the protocol hint.
        assert.equal(permissionReplies.length, 1);
        const reply = JSON.parse(permissionReplies[0].body);
        assert.equal(reply.decision, 'reject');
        assert.match(reply.message, /dsh-tool/);

        const text = events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('');
        assert.equal(text, 'answered without touching the disk');
    }
    finally {
        close();
    }
});
