/**
 * Type surface for dsh-opencode-local.
 *
 * The runtime entry is plain ESM (`lib/index.js`); this file only describes the
 * shapes a host or a downstream build needs to see.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PluginLogger, LoggerLike, LogLevel } from './logger.js';

export interface OpenCodeLocalConfig {
    providers: string[];
    cliPath: string;
    port: number;
    directory: string;
    modelRefreshIntervalMs: number;
    logLevel: LogLevel | string;
    logDir: string;
    logMaxBytes: number;
    logMaxFiles: number;
}

/** One model the local service advertises. */
export interface OpenCodeModel {
    id: string;
    name: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    inputModalities?: Array<'text' | 'image'>;
}

export declare const name: 'dsh-opencode-local';
export declare const inject: ['llm'];
export declare const Config: unknown;

/**
 * Resolve this plugin into the Host.
 *
 * Every field of `config` is optional in practice: the Host may hand over an
 * unresolved or stale object, and this function normalizes whatever it gets.
 * It never throws — a third-party plugin must not abort a Harness boot or a
 * settings projection that enumerates installed plugins.
 *
 * No child process is started here; `opencode serve` starts on first use.
 */
export declare function apply(ctx: Context, config?: Partial<OpenCodeLocalConfig>): void;

export declare function findCliBinary(): string | undefined;

export { LocalOpenCodeService } from './local-service.js';
export { LocalOpenCodeAdapter } from './local-adapter.js';
export { PluginLogger, defaultLogDir } from './logger.js';
export type { LoggerLike, LogLevel };
