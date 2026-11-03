/**
 * Unit tests for the native-call bridge.
 *
 * The mapping is schema-driven, so these tests use the *real* DSH tool schemas
 * captured from a live prompt rather than shapes invented here.
 *
 * Run: node --test test/native-bridge.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeNativeCall } from '../lib/native-bridge.js';

const bashTool = {
    name: 'bash',
    parameters: {
        type: 'object',
        properties: {
            description: { type: 'string' },
            command: { type: 'string' },
            timeoutMs: { type: 'number' },
            workdir: { type: 'string' },
        },
        required: ['description', 'command'],
    },
};

const readTool = {
    name: 'read',
    parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
        required: ['file_path'],
    },
};

const webSearchTool = {
    name: 'web_search',
    parameters: {
        type: 'object',
        properties: { queries: { type: 'array', items: { type: 'string' } } },
        required: ['queries'],
    },
};

test('shell becomes bash with a derived description', () => {
    const bridged = bridgeNativeCall(
        { name: 'shell', input: { command: 'ls -la\nwc -l' } },
        [bashTool],
    );
    assert.ok(bridged);
    assert.equal(bridged.name, 'bash');
    const args = JSON.parse(bridged.arguments);
    assert.equal(args.command, 'ls -la\nwc -l');
    // Only the first line, so a multi-line command still labels the call.
    assert.equal(args.description, 'ls -la');
});

test('camelCase arguments land on snake_case properties', () => {
    const bridged = bridgeNativeCall(
        { name: 'read', input: { filePath: '/etc/hosts', offset: 10, limit: 20 } },
        [readTool],
    );
    assert.ok(bridged);
    assert.deepEqual(JSON.parse(bridged.arguments), { file_path: '/etc/hosts', offset: 10, limit: 20 });
});

test('a single query is wrapped for the multi-query tool', () => {
    const bridged = bridgeNativeCall({ name: 'websearch', input: { query: 'dsh' } }, [webSearchTool]);
    assert.ok(bridged);
    assert.deepEqual(JSON.parse(bridged.arguments), { queries: ['dsh'] });
});

test('unknown tools and unoffered tools are not bridged', () => {
    // `task` has different semantics on each side.
    assert.equal(bridgeNativeCall({ name: 'task', input: { prompt: 'x' } }, [bashTool]), null);
    // `bash` is known, but DSH did not offer it this turn.
    assert.equal(bridgeNativeCall({ name: 'shell', input: { command: 'ls' } }, [readTool]), null);
});

test('a missing required argument is not invented', () => {
    // No command at all: there is nothing honest to send.
    assert.equal(bridgeNativeCall({ name: 'shell', input: {} }, [bashTool]), null);
    // A read without a path cannot be guessed either.
    assert.equal(bridgeNativeCall({ name: 'read', input: {} }, [readTool]), null);
});

test('malformed input is rejected rather than coerced', () => {
    assert.equal(bridgeNativeCall({ name: 'shell', input: null }, [bashTool]), null);
    assert.equal(bridgeNativeCall({ name: 'shell', input: ['ls'] }, [bashTool]), null);
    assert.equal(bridgeNativeCall({ name: 'shell' }, [bashTool]), null);
    assert.equal(bridgeNativeCall(null, [bashTool]), null);
});
