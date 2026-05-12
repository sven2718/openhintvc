// SiS Dev extension logger.
//
// Funnels every L.trace / L.debug / ... call from the extension into a
// single user-visible VS Code OutputChannel named "SiS Dev". Open it
// via `View -> Output -> SiS Dev` (the status-bar item also reveals it
// on click). The languageclient's own "SiS Lua LSP" channel stays
// separate and carries protocol-level traffic; this channel is for
// extension-side diagnostics (staging failures, lifecycle state, etc.).
//
// Before 0.2.0 this used log4js with a `stdout` appender. That routed
// trace/debug/info into the extension host's stdout, which is not
// visible from a normal VS Code session - so when the LSP failed to
// start there was no breadcrumb anywhere.
//
// Volume control: `Server.ts` (OpenHint) logs at trace level on every
// chunk byte, which would drown the channel. The default threshold is
// 'debug'; set `SIS_DEV_LOG_LEVEL=trace` in the environment before
// launching VS Code to get the firehose when debugging the extension
// itself.

import * as util from 'node:util';
import * as vscode from 'vscode';

const CHANNEL_NAME = 'SiS Dev';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
};

function resolveThreshold(): number {
	const env = (process.env.SIS_DEV_LOG_LEVEL ?? '').toLowerCase();
	if (env in LEVEL_ORDER) return LEVEL_ORDER[env as LogLevel];
	return LEVEL_ORDER.debug;
}

const THRESHOLD = resolveThreshold();

let _channel: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
	if (!_channel) _channel = vscode.window.createOutputChannel(CHANNEL_NAME);
	return _channel;
}

function fmt(a: unknown): string {
	if (typeof a === 'string') return a;
	if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
	// util.inspect handles cyclic refs, undefined, bigints, etc., where
	// JSON.stringify would either throw or silently drop fields.
	return util.inspect(a, { depth: 3, breakLength: Infinity });
}

function emit(level: LogLevel, name: string, args: unknown[]): void {
	if (LEVEL_ORDER[level] < THRESHOLD) return;
	const ts = new Date().toISOString();
	const rest = args.map(fmt).join(' ');
	channel().appendLine(`${ts} [${level.padEnd(5)}] [${name}] ${rest}`);
}

export interface ChannelLogger {
	trace(...args: unknown[]): void;
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

function makeLogger(name: string): ChannelLogger {
	return {
		trace: (...a) => emit('trace', name, a),
		debug: (...a) => emit('debug', name, a),
		info: (...a) => emit('info', name, a),
		warn: (...a) => emit('warn', name, a),
		error: (...a) => emit('error', name, a),
	};
}

// Reveal the channel; used by the status-bar item click handler. We
// pass `preserveFocus=true` so the editor doesn't lose focus.
function show(): void {
	channel().show(true);
}

function dispose(): void {
	_channel?.dispose();
	_channel = undefined;
}

export default {
	getLogger: makeLogger,
	show,
	dispose,
};
