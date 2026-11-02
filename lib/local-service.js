/**
 * Local OpenCode service manager.
 *
 * The free-tier models at opencode.ai only answer requests made by the OpenCode
 * client itself. Rather than impersonating that client over the network, we
 * reuse the real client that ships with the OpenCode desktop app: its `serve`
 * subcommand exposes the same v2 API locally, on a loopback port, guarded by a
 * per-process random password.
 *
 * This module owns the lifecycle of that child process:
 *   - find the CLI binary (the app updates it, so the version dir changes)
 *   - start it on a free loopback port
 *   - read the password it prints on startup
 *   - stop it when the plugin unloads
 *
 * Nothing here touches the network beyond 127.0.0.1.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'ai.opencode.desktop');
const CLI_ROOT = path.join(APP_SUPPORT, 'cli');
const READY_TIMEOUT_MS = 20_000;

/** Compare two semver-ish strings, newest last. Non-numeric parts fall back to string order. */
function compareVersion(a, b) {
    const pa = a.split(/[.-]/);
    const pb = b.split(/[.-]/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? '';
        const y = pb[i] ?? '';
        const nx = /^\d+$/.test(x);
        const ny = /^\d+$/.test(y);
        if (nx && ny) {
            const d = Number(x) - Number(y);
            if (d !== 0) return d;
            continue;
        }
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/**
 * Locate the newest installed `opencode-cli`.
 *
 * The desktop app keeps each version in its own directory and renames the
 * binary between releases, so both the directory and the file name are probed
 * rather than hard-coded.
 */
export function findCliBinary() {
    const candidates = [];

    // The desktop app manages a versioned CLI dir; prefer the newest.
    try {
        const versions = fs.readdirSync(CLI_ROOT).filter((name) => /^\d+\.\d+\.\d+/.test(name)).sort(compareVersion);
        for (const version of versions.reverse()) {
            const dir = path.join(CLI_ROOT, version);
            for (const bin of ['opencode-cli', 'opencode']) {
                const full = path.join(dir, bin);
                if (fs.existsSync(full)) candidates.push(full);
            }
        }
    }
    catch {
        // No desktop app installed, or the directory is unreadable.
    }

    // A PATH-installed CLI is a legitimate fallback for people using the TUI build.
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        for (const bin of ['opencode', 'opencode-cli']) {
            const full = path.join(dir, bin);
            try {
                if (fs.existsSync(full)) candidates.push(full);
            }
            catch { /* unreadable PATH entry */ }
        }
    }

    return candidates[0];
}

/** Ask the OS for a loopback port that is free right now. */
function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns one `opencode serve` child process.
 *
 * `start()` is idempotent: concurrent callers share the in-flight promise, so a
 * burst of requests launches exactly one process.
 */
export class LocalOpenCodeService {
    child;
    port;
    password;
    starting;
    stopping = false;
    logger;
    stderr = '';

    constructor(options = {}) {
        this.options = options;
        this.logger = options.logger ?? { info() {}, warn() {}, debug() {}, error() {} };
    }

    get origin() {
        return this.port ? `http://127.0.0.1:${this.port}` : undefined;
    }

    get running() {
        return Boolean(this.child && this.port && this.password);
    }

    headers() {
        if (!this.password) return {};
        const token = Buffer.from(`opencode:${this.password}`).toString('base64');
        return { authorization: `Basic ${token}` };
    }

    /** Start (or reuse) the service and resolve once it answers authenticated requests. */
    start() {
        if (this.running) return Promise.resolve(this);
        if (this.starting) return this.starting;
        this.starting = this.launch().finally(() => { this.starting = undefined; });
        return this.starting;
    }

    async launch() {
        const binary = this.options.binary ?? findCliBinary();
        if (!binary) {
            throw new Error('OpenCode CLI not found. Install the OpenCode desktop app, or add `opencode` to PATH.');
        }

        const port = this.options.port ?? await freePort();
        const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
        });
        this.child = child;
        this.port = port;
        this.stderr = '';

        // The password is printed once on startup; stdout is the only place it appears.
        let buffer = '';
        const password = await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.off('exit', onExit);
                fn(value);
            };
            const timer = setTimeout(
                () => finish(reject, new Error(`opencode serve did not become ready within ${READY_TIMEOUT_MS}ms`)),
                READY_TIMEOUT_MS,
            );
            const onExit = (code) => finish(reject, new Error(`opencode serve exited during startup (code ${code})`));

            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                buffer += chunk;
                const match = /server password\s+(\S+)/.exec(buffer);
                if (match) finish(resolve, match[1]);
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {
                this.stderr = (this.stderr + chunk).slice(-8_000);
            });
            child.on('exit', onExit);
            child.on('error', (error) => finish(reject, error));
        }).catch((error) => {
            this.stop();
            throw error;
        });

        this.password = password;
        this.logger.info('local-service', 'started', { origin: this.origin, binary, pid: child.pid });

        // The process dying must invalidate our handle, or the next call would
        // reuse a dead origin and fail with a confusing connection error.
        child.on('exit', (code, signal) => {
            this.logger.warn('local-service', 'exited', { code, signal });
            if (this.child === child) {
                this.child = undefined;
                this.port = undefined;
                this.password = undefined;
            }
        });

        // Verify the password actually works before reporting success.
        await this.waitForHealthy();
        return this;
    }

    async waitForHealthy() {
        const deadline = Date.now() + READY_TIMEOUT_MS;
        let lastError;
        while (Date.now() < deadline) {
            try {
                const response = await fetch(`${this.origin}/api/info`, {
                    headers: this.headers(),
                    signal: AbortSignal.timeout(3_000),
                });
                if (response.ok) {
                    await response.body?.cancel();
                    return;
                }
                lastError = new Error(`/api/info HTTP ${response.status}`);
            }
            catch (error) {
                lastError = error;
            }
            await sleep(150);
        }
        throw new Error(`opencode serve did not accept authenticated requests: ${lastError?.message ?? 'timeout'}`);
    }

    /** Terminate the child. Safe to call repeatedly, and safe when never started. */
    stop() {
        const child = this.child;
        this.child = undefined;
        this.port = undefined;
        this.password = undefined;
        if (!child || child.exitCode !== null) return;
        this.stopping = true;
        try {
            child.kill('SIGTERM');
            // Escalate if it ignores SIGTERM; the port must not be leaked.
            const timer = setTimeout(() => {
                if (child.exitCode === null) {
                    try { child.kill('SIGKILL'); } catch { /* already gone */ }
                }
            }, 3_000);
            timer.unref?.();
            child.once('exit', () => clearTimeout(timer));
        }
        catch {
            // Killing an already-reaped child is not an error worth surfacing.
        }
        finally {
            this.stopping = false;
        }
    }
}
