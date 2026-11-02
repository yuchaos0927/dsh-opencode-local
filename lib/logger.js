/**
 * Leveled file logger for dsh-opencode-local.
 *
 * Design constraints (see TECHNICAL.md "Logging & diagnostics"):
 *
 * - **No sensitive information ever reaches the log.** Call sites log
 *   metadata only (counts, sizes, ids, status codes, timings) — never message
 *   content, tool arguments, or credentials. On top of that, every string that
 *   passes through the logger is scrubbed: configured secrets (the API key),
 *   `Bearer <token>` values and token-shaped literals are replaced, and long
 *   strings are truncated.
 * - **Bounded disk usage.** One active file plus `maxFiles - 1` rotated
 *   siblings, each at most `maxBytes`. When the active file would overflow, the
 *   oldest rotated file is deleted first — logs are cleaned oldest-first and
 *   total usage never exceeds `maxBytes * maxFiles`.
 * - **Never throws.** Logging must not break model traffic; every fs operation
 *   is wrapped and failures fall back to an in-memory ring that the read API
 *   still serves.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const RANK = { debug: 10, info: 20, warn: 30, error: 40, off: 100 };
/** A logger that discards everything; the default for standalone use. */
export const noopLogger = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
};
const MAX_STRING = 2000;
const MEMORY_FALLBACK_LIMIT = 200;
/** Default log directory: profile logs dir when known, else `~/.dsh/logs`. */
export function defaultLogDir() {
    const base = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh');
    return path.join(base, 'logs', 'dsh-opencode-local');
}
export class PluginLogger {
    level;
    dir;
    maxBytes;
    maxFiles;
    secrets;
    base;
    mirror;
    memory = [];
    constructor(options) {
        this.level = options.level;
        this.dir = options.dir;
        this.maxBytes = Math.max(256, options.maxBytes);
        this.maxFiles = Math.max(1, Math.min(50, options.maxFiles));
        this.base = path.join(this.dir, 'dsh-opencode-local.log');
        this.secrets = (options.secrets ?? []).filter((s) => typeof s === 'string' && s.length >= 4 && s !== 'public');
        this.mirror = options.mirror;
        this.pruneExcess();
    }
    /** Runtime level change (UI-driven); persisted only through config. */
    setLevel(level) {
        this.level = level;
    }
    getLevel() {
        return this.level;
    }
    debug(scope, msg, data) {
        this.emit('debug', scope, msg, data);
    }
    info(scope, msg, data) {
        this.emit('info', scope, msg, data);
    }
    warn(scope, msg, data) {
        this.emit('warn', scope, msg, data);
    }
    error(scope, msg, data) {
        this.emit('error', scope, msg, data);
    }
    /** Formatted single line, used for both the file and the memory fallback. */
    format(record) {
        const data = record.data && Object.keys(record.data).length ? ` ${this.redact(JSON.stringify(record.data))}` : '';
        return `${record.ts} [${record.level.toUpperCase().padEnd(5)}] [${record.scope}] ${this.redact(record.msg)}${data}`;
    }
    /**
     * Scrub sensitive material from any string: configured secrets, bearer
     * tokens, token-shaped literals; then cap the length.
     */
    redact(input) {
        let out = input;
        for (const secret of this.secrets)
            out = out.split(secret).join('[redacted]');
        out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]');
        out = out.replace(/\b(sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi, '[redacted]');
        return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out;
    }
    /** Newest-last records, filtered by minimum level, capped to `limit`. */
    read(options = {}) {
        const min = RANK[options.level ?? 'debug'];
        const limit = Math.max(1, Math.min(5000, options.limit ?? 500));
        const lines = [];
        // Chronological order: oldest rotated file first, active file last.
        for (let i = this.maxFiles - 1; i >= 0; i--) {
            const file = i === 0 ? this.base : `${this.base}.${i}`;
            for (const raw of this.readLines(file)) {
                if (this.rankOf(raw) >= min)
                    lines.push(raw);
            }
        }
        if (!lines.length && this.memory.length) {
            for (const raw of this.memory)
                if (this.rankOf(raw) >= min)
                    lines.push(raw);
        }
        const truncated = lines.length > limit;
        return { lines: truncated ? lines.slice(-limit) : lines, truncated };
    }
    /** Files on disk with sizes, plus current level and record count. */
    stat() {
        const files = [];
        for (let i = 0; i < this.maxFiles; i++) {
            const name = i === 0 ? path.basename(this.base) : `${path.basename(this.base)}.${i}`;
            const full = i === 0 ? this.base : `${this.base}.${i}`;
            const bytes = this.sizeOf(full);
            if (bytes > 0)
                files.push({ name, bytes });
        }
        return {
            dir: this.dir,
            file: this.base,
            level: this.level,
            maxBytes: this.maxBytes,
            maxFiles: this.maxFiles,
            files,
            totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
            recordCount: this.read({ limit: 5000 }).lines.length,
        };
    }
    /** Delete every log file; returns how many were removed. */
    clear() {
        let removed = 0;
        for (let i = 0; i < this.maxFiles; i++) {
            const full = i === 0 ? this.base : `${this.base}.${i}`;
            try {
                if (fs.existsSync(full)) {
                    fs.unlinkSync(full);
                    removed++;
                }
            }
            catch {
                // Best effort; the next append recreates what it needs.
            }
        }
        this.memory = [];
        return removed;
    }
    // -- internals ------------------------------------------------------------
    emit(level, scope, msg, data) {
        if (RANK[level] < RANK[this.level])
            return;
        const record = {
            ts: new Date().toISOString(),
            level,
            scope,
            msg,
            ...(data && Object.keys(data).length ? { data: this.scrubData(data) } : {}),
        };
        const line = this.format(record);
        this.memory.push(line);
        if (this.memory.length > MEMORY_FALLBACK_LIMIT)
            this.memory.shift();
        try {
            this.mirror?.(line);
        }
        catch {
            // Mirroring must never break logging.
        }
        this.appendLine(line);
    }
    /** Redact every string inside a data record and cap nesting by serialization. */
    scrubData(data) {
        const out = {};
        for (const [key, value] of Object.entries(data)) {
            if (value === undefined)
                continue;
            if (typeof value === 'string')
                out[key] = this.redact(value);
            else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
                out[key] = value;
            else if (Array.isArray(value))
                out[key] = this.redact(JSON.stringify(value));
            else
                out[key] = this.redact(JSON.stringify(value));
        }
        return out;
    }
    appendLine(line) {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const bytes = Buffer.byteLength(line) + 1;
            if (this.sizeOf(this.base) + bytes > this.maxBytes)
                this.rotate();
            fs.appendFileSync(this.base, `${line}\n`, 'utf8');
        }
        catch {
            // Disk output is best-effort; the memory ring still holds recent lines.
        }
    }
    /**
     * Shift the active file into `.1`, moving older siblings up and deleting the
     * oldest one — "clean the earliest logs first" when the log gets too large.
     */
    rotate() {
        try {
            const oldest = `${this.base}.${this.maxFiles - 1}`;
            if (this.maxFiles > 1 && fs.existsSync(oldest))
                fs.unlinkSync(oldest);
            for (let i = this.maxFiles - 2; i >= 1; i--) {
                const from = `${this.base}.${i}`;
                if (fs.existsSync(from))
                    fs.renameSync(from, `${this.base}.${i + 1}`);
            }
            if (fs.existsSync(this.base))
                fs.renameSync(this.base, `${this.base}.1`);
        }
        catch {
            // If rotation fails, appendLine's caller keeps running on the old file.
        }
    }
    /** Delete rotated siblings beyond the configured retention on startup. */
    pruneExcess() {
        try {
            for (let i = this.maxFiles; i <= 50; i++) {
                const full = `${this.base}.${i}`;
                if (fs.existsSync(full))
                    fs.unlinkSync(full);
            }
        }
        catch {
            // Ignore; stale extra files are harmless.
        }
    }
    readLines(file) {
        try {
            if (!fs.existsSync(file))
                return [];
            return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
        }
        catch {
            return [];
        }
    }
    sizeOf(file) {
        try {
            return fs.existsSync(file) ? fs.statSync(file).size : 0;
        }
        catch {
            return 0;
        }
    }
    /** Extract the level from a formatted line so filtering works on disk lines. */
    rankOf(line) {
        const match = /\[(DEBUG|INFO |WARN |ERROR)\]/.exec(line);
        if (!match)
            return RANK.debug;
        const key = match[1].trim().toLowerCase();
        return RANK[key] ?? RANK.debug;
    }
}
/** Console-backed logger for tests and standalone use. */
export function consoleLogger(level = 'debug') {
    return new PluginLogger({
        level,
        dir: path.join(os.tmpdir(), 'dsh-opencode-local-console'),
        maxBytes: 64 * 1024,
        maxFiles: 1,
    });
}
