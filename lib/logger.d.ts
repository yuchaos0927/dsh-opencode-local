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
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';
export type ActiveLevel = Exclude<LogLevel, 'off'>;
/** Structural logger contract consumed by the catalog and the adapter. */
export interface LoggerLike {
    debug(scope: string, msg: string, data?: Record<string, unknown>): void;
    info(scope: string, msg: string, data?: Record<string, unknown>): void;
    warn(scope: string, msg: string, data?: Record<string, unknown>): void;
    error(scope: string, msg: string, data?: Record<string, unknown>): void;
}
/** A logger that discards everything; the default for standalone use. */
export declare const noopLogger: LoggerLike;
export interface LogRecord {
    ts: string;
    level: ActiveLevel;
    scope: string;
    msg: string;
    data?: Record<string, unknown>;
}
export interface LoggerOptions {
    /** Minimum level written to disk. `off` disables file output entirely. */
    level: LogLevel;
    /** Directory holding `dsh-opencode-local.log` and its rotated siblings. */
    dir: string;
    /** Size ceiling per file in bytes. */
    maxBytes: number;
    /** Total files kept (active + rotated); the oldest is deleted on overflow. */
    maxFiles: number;
    /** Literal secret strings scrubbed from every logged string. */
    secrets?: string[];
    /**
     * Optional console mirror (e.g. `console.log`) receiving the same formatted
     * line. Useful because the DSH Host terminal shows console output; the file
     * remains the durable, viewable record.
     */
    mirror?: (line: string) => void;
}
export interface LogStat {
    dir: string;
    file: string;
    level: LogLevel;
    maxBytes: number;
    maxFiles: number;
    files: Array<{
        name: string;
        bytes: number;
    }>;
    totalBytes: number;
    recordCount: number;
}
/** Default log directory: profile logs dir when known, else `~/.dsh/logs`. */
export declare function defaultLogDir(): string;
export declare class PluginLogger {
    private level;
    private readonly dir;
    private readonly maxBytes;
    private readonly maxFiles;
    private readonly secrets;
    private readonly base;
    private readonly mirror;
    private memory;
    constructor(options: LoggerOptions);
    /** Runtime level change (UI-driven); persisted only through config. */
    setLevel(level: LogLevel): void;
    getLevel(): LogLevel;
    debug(scope: string, msg: string, data?: Record<string, unknown>): void;
    info(scope: string, msg: string, data?: Record<string, unknown>): void;
    warn(scope: string, msg: string, data?: Record<string, unknown>): void;
    error(scope: string, msg: string, data?: Record<string, unknown>): void;
    /** Formatted single line, used for both the file and the memory fallback. */
    format(record: LogRecord): string;
    /**
     * Scrub sensitive material from any string: configured secrets, bearer
     * tokens, token-shaped literals; then cap the length.
     */
    redact(input: string): string;
    /** Newest-last records, filtered by minimum level, capped to `limit`. */
    read(options?: {
        level?: LogLevel;
        limit?: number;
    }): {
        lines: string[];
        truncated: boolean;
    };
    /** Files on disk with sizes, plus current level and record count. */
    stat(): LogStat;
    /** Delete every log file; returns how many were removed. */
    clear(): number;
    private emit;
    /** Redact every string inside a data record and cap nesting by serialization. */
    private scrubData;
    private appendLine;
    /**
     * Shift the active file into `.1`, moving older siblings up and deleting the
     * oldest one — "clean the earliest logs first" when the log gets too large.
     */
    private rotate;
    /** Delete rotated siblings beyond the configured retention on startup. */
    private pruneExcess;
    private readLines;
    private sizeOf;
    /** Extract the level from a formatted line so filtering works on disk lines. */
    private rankOf;
}
/** Console-backed logger for tests and standalone use. */
export declare function consoleLogger(level?: LogLevel): PluginLogger;
