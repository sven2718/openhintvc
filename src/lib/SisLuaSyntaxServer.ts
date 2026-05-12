import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';
import * as vscode from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	State as LcState,
	Trace,
} from 'vscode-languageclient/node';

import Logger from '../utils/Logger';

// SisLuaSyntaxServer wraps `sis_headless -lsp` (the canonical SiS Lua
// language server, see `docs/tags.md` #sis_lua_lsp) as a
// `vscode-languageclient` connection.
//
// Design points worth preserving when editing this file:
//
//  - **No parallel DiagnosticCollection.** The `LanguageClient` already
//    owns one keyed by its own id, populated automatically from the
//    server's `textDocument/publishDiagnostics`. Duplicating that here
//    ends with every error showing up twice in the Problems panel. Don't.
//
//  - **No `handleDiagnostics` middleware.** Same reason. The default
//    behavior is correct.
//
//  - **Serialized lifecycle.** All start/stop/restart calls run through
//    `this.lifecycle` so two concurrent callers can't each spawn a child
//    process. `tokenize()` does NOT go through that chain since it only
//    reads the current client.
//
//  - **Stage `sis_headless` to a tempdir before spawning (Windows only).**
//    Spawning the canonical exe directly puts a Windows image-load lock
//    on it for the entire LSP session, which fights `link.exe /OUT:<exe>`
//    during incremental rebuilds. `stageSisHeadlessForLsp` (below) copies
//    the exe + sibling DLLs into `%TEMP%/sis_headless_lsp/<key>_<mtime>/`
//    and returns the staged path; we hand THAT to `LanguageClient`. The
//    Python launcher under `tools/sis_headless_lsp_launcher.py` does the
//    same dance for non-VS Code clients (Crush, etc.). On Linux/macOS
//    there is no image-load lock, so we spawn the canonical binary
//    directly.
//
//  - **Optional startup.** Constructor does not auto-start. The
//    extension activation layer decides when to `start()` based on
//    `sisDev.luaSyntaxDiagnostics.enabled`, workspace shape, and exe
//    availability.
//
//  - **State surface.** A status-bar item and one-shot notifications
//    reflect the lifecycle so silent failures (no exe, staging refused,
//    init handshake rejected) actually reach the user instead of
//    rotting in an invisible log.

const L = Logger.getLogger('SisLuaSyntaxServer');

const MAX_TEXT_CHARS = 1024 * 1024;

// How long to wait for `client.start()` to complete before declaring the
// LSP server hung and surfacing a visible failure. Cold boot of
// `sis_headless` takes ~1s; 15s is generous enough to ride out a slow
// startup but short enough that a real hang stops being invisible to the
// user.
const CLIENT_START_TIMEOUT_MS = 15_000;

function fileExists(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function dirExists(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function getConfiguredSisHeadlessPath(): string | undefined {
	const config = vscode.workspace.getConfiguration('sisDev');
	const raw = config.get<string>('luaSyntaxDiagnostics.sisHeadlessPath', '');
	const trimmed = typeof raw === 'string' ? raw.trim() : '';
	return trimmed.length > 0 ? trimmed : undefined;
}

// `sis_headless` only behaves sanely when CWD contains a `Lua state/`
// directory. Mirror the auto-detection from before phase 2: accept either
// the repo root (which has `resources/Lua state`) or a mod-kit layout
// where the workspace IS `Lua state/` (so CWD = parent).
function findLuaStateCwd(workspaceFolderPath: string): string | undefined {
	if (dirExists(path.join(workspaceFolderPath, 'Lua state'))) {
		return workspaceFolderPath;
	}

	if (path.basename(workspaceFolderPath).toLowerCase() === 'lua state') {
		const parentDir = path.dirname(workspaceFolderPath);
		if (dirExists(path.join(parentDir, 'Lua state'))) {
			return parentDir;
		}
	}

	const resourcesDir = path.join(workspaceFolderPath, 'resources');
	if (dirExists(path.join(resourcesDir, 'Lua state'))) {
		return resourcesDir;
	}
	return undefined;
}

function findSisHeadlessExecutable(workspaceFolderPath: string): string | undefined {
	const configured = getConfiguredSisHeadlessPath();
	if (configured && fileExists(configured)) return configured;

	// Search both the workspace folder and its parent. The "parent" path
	// covers the case where the workspace is `Lua state/` itself.
	const roots = [workspaceFolderPath, path.dirname(workspaceFolderPath)];

	const candidates: string[] = [];
	if (process.platform === 'win32') {
		for (const root of roots) {
			candidates.push(path.join(root, 'sis_headless.exe'));
			candidates.push(path.join(root, 'x64', 'Release', 'sis_headless.exe'));
			candidates.push(path.join(root, 'x64', 'Debug', 'sis_headless.exe'));
		}
	} else {
		for (const root of roots) {
			candidates.push(path.join(root, 'sis_headless'));
			candidates.push(path.join(root, 'linux', 'build', 'sis_headless'));
			candidates.push(path.join(root, 'build', 'sis_headless'));
		}
	}

	for (const c of candidates) {
		if (fileExists(c)) return c;
	}
	return undefined;
}

// -- Tempdir staging --------------------------------------------------------
//
// #sis_lua_lsp
//
// Layout (must stay byte-for-byte compatible with the Python launcher
// under `tools/sis_headless_lsp_launcher.py` so the two clients share
// staged copies instead of fighting over parallel dirs):
//
//     %TEMP%/sis_headless_lsp/
//         <pathSha1[:16]>_<mtimeNs>/
//             sis_headless.exe        <- staged
//             *.dll                   <- staged siblings
//
// The dir name includes the source exe's nanosecond mtime, so a
// rebuild always lands in a fresh dir. The old staged copy may still
// be held open by a previous LSP child - that's fine; we don't touch
// it, and the per-key sweep below GC's it once nothing has it locked.
//
// Before 0.2.0 the dir name was just the path hash and the staged file
// was overwritten in place. That fought any still-running LSP child
// for the file lock (`copyFileSync -> EBUSY` -> silent abort -> no
// diagnostics for the rest of the session).

const STAGING_ROOT_NAME = 'sis_headless_lsp';
const STAGING_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

function stagingRoot(): string {
	return path.join(os.tmpdir(), STAGING_ROOT_NAME);
}

// Normalize so the TS and Python launchers hash to the same key.
// `path.resolve` on Windows preserves the original drive-letter case,
// so e.g. VS Code's `c:\...` and Python's `C:\...` would otherwise
// produce two different sha1s and two parallel staging dirs.
function normalizeStagingPath(p: string): string {
	return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function stagingKey(sourceExe: string): string {
	return crypto
		.createHash('sha1')
		.update(normalizeStagingPath(sourceExe), 'utf-8')
		.digest('hex')
		.slice(0, 16);
}

function stagingDirFor(sourceExe: string, mtimeNs: bigint): string {
	return path.join(stagingRoot(), `${stagingKey(sourceExe)}_${mtimeNs}`);
}

// Best-effort cleanup: remove staging dirs whose mtime is older than
// `STAGING_SWEEP_AGE_MS`. A dir whose exe is currently held open by
// another LSP child will fail to delete; we silently move on and rely
// on a future sweep.
function sweepOldStagingDirs(): void {
	const root = stagingRoot();
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return;
	}
	const cutoff = Date.now() - STAGING_SWEEP_AGE_MS;
	for (const entry of entries) {
		const entryPath = path.join(root, entry);
		try {
			if (fs.statSync(entryPath).mtimeMs < cutoff) {
				fs.rmSync(entryPath, { recursive: true, force: true });
			}
		} catch {
			// leave it for next sweep
		}
	}
}

// Eager per-key cleanup: drop sibling staged versions of the same
// source exe path. Runs alongside `sweepOldStagingDirs` so heavy
// rebuild sessions don't accumulate 24h of 9MB stale copies.
//
// A locked sibling silently survives (rmSync throws, we swallow).
function pruneSiblingStagingVersions(sourceExe: string, currentDir: string): void {
	const root = stagingRoot();
	const prefix = `${stagingKey(sourceExe)}_`;
	const currentName = path.basename(currentDir);
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === currentName) continue;
		if (!entry.startsWith(prefix)) continue;
		try {
			fs.rmSync(path.join(root, entry), { recursive: true, force: true });
		} catch {
			// locked or otherwise unkillable; leave for next pass
		}
	}
}

// Returns the staged exe path on success, or `undefined` if staging
// failed for any reason (in which case the caller can either fall back
// to the canonical path or just refuse to start). The returned error
// (if any) is surfaced via the caller's state machine.
interface StageResult {
	stagedExe?: string;
	error?: string;
}

function stageSisHeadlessForLsp(sourceExe: string): StageResult {
	const absSource = path.resolve(sourceExe);

	// `mtimeNs` (bigint) is the nanosecond field exposed by
	// `statSync({bigint:true})`. We do NOT pull it from `mtimeMs * 1e6`
	// because that loses the lower ~16 bits of precision on Windows
	// NTFS (mtime is a 100ns FILETIME).
	let mtimeNs: bigint;
	try {
		mtimeNs = fs.statSync(absSource, { bigint: true }).mtimeNs;
	} catch (err) {
		const msg = `source stat failed: ${err instanceof Error ? err.message : String(err)}`;
		L.warn('stageSisHeadlessForLsp:', msg);
		return { error: msg };
	}

	const stagingDir = stagingDirFor(absSource, mtimeNs);
	const stagedExe = path.join(stagingDir, path.basename(absSource));

	if (fileExists(stagedExe)) {
		// Warm path: this exact build is already staged.
		return { stagedExe };
	}

	try {
		fs.mkdirSync(stagingDir, { recursive: true });
		fs.copyFileSync(absSource, stagedExe);
	} catch (err) {
		const msg = `copy to ${stagingDir} failed: ${err instanceof Error ? err.message : String(err)}`;
		L.error('stageSisHeadlessForLsp:', msg);
		return { error: msg };
	}

	// Copy sibling .dll files. In dev builds there usually aren't any
	// next to `sis_headless.exe` (DLLs live under `resources/x64/`); in
	// a production install they're siblings. Best-effort: a missing
	// sibling DLL is not fatal in -lsp mode, which gates off the
	// optional runtime integrations that would actually need them.
	const sourceDir = path.dirname(absSource);
	let siblings: string[] = [];
	try {
		siblings = fs.readdirSync(sourceDir);
	} catch {
		// no siblings; that's fine
	}
	for (const sibling of siblings) {
		if (!sibling.toLowerCase().endsWith('.dll')) continue;
		const src = path.join(sourceDir, sibling);
		try {
			if (!fs.statSync(src).isFile()) continue;
			fs.copyFileSync(src, path.join(stagingDir, sibling));
		} catch {
			// best-effort
		}
	}

	pruneSiblingStagingVersions(absSource, stagingDir);
	return { stagedExe };
}

// Startup info for a particular workspace folder. We recompute this on
// every lifecycle op so a user toggling `sisHeadlessPath` mid-session
// still takes effect on the next `restart()`.
interface StartInfo {
	executable: string;
	cwd: string;
}

interface StartInfoLookup {
	info?: StartInfo;
	// Non-fatal reason explaining why no info was returned. Used by the
	// status surface to tell "we're in a SiS workspace but the exe
	// hasn't been built yet" apart from "this workspace just isn't SiS".
	reason?: string;
}

function resolveStartInfo(): StartInfoLookup {
	const folders = vscode.workspace.workspaceFolders ?? [];
	let sawSisShape = false;
	for (const folder of folders) {
		const folderPath = folder.uri.fsPath;
		const cwd = findLuaStateCwd(folderPath);
		if (!cwd) continue;
		sawSisShape = true;
		const executable = findSisHeadlessExecutable(folderPath);
		if (!executable) continue;
		return { info: { executable, cwd } };
	}
	if (sawSisShape) {
		return {
			reason:
				'no sis_headless executable found in workspace (build x64/Release/sis_headless.exe or set sisDev.luaSyntaxDiagnostics.sisHeadlessPath)',
		};
	}
	return { reason: 'no SiS-shaped workspace folder' };
}

// Quick gate used by extension activation: returns true if any open
// workspace folder looks SiS-shaped - i.e., has a `Lua state/` (or
// `resources/Lua state/`) directory or a discoverable `sis_headless`
// binary. Used to keep the extension dormant in unrelated workspaces
// instead of looping on a failing OpenHint server start.
export function isSisWorkspace(): boolean {
	const folders = vscode.workspace.workspaceFolders ?? [];
	for (const folder of folders) {
		const folderPath = folder.uri.fsPath;
		if (findLuaStateCwd(folderPath)) return true;
		if (findSisHeadlessExecutable(folderPath)) return true;
	}
	return false;
}

export type SisLuaTokenKind = 'identifier' | 'keyword' | 'punct' | 'number';

export type SisLuaToken = {
	kind: SisLuaTokenKind;
	text: string;
	offset: number;
	atLineStart: boolean;
	line?: number;
};

// -- Status surface ---------------------------------------------------------
//
// One status-bar item, one notification per failure reason per session.

type LspStatus =
	| { kind: 'idle' } // disabled by config, or extension just constructed
	| { kind: 'starting'; info: StartInfo }
	| { kind: 'running'; info: StartInfo }
	| { kind: 'stopped' }
	| { kind: 'unavailable'; reason: string } // workspace looks SiS but no exe
	| { kind: 'failed'; reason: string };

// Command registered by the SisLua status bar item. Clicking it opens
// the "SiS Dev" output channel so the user can see the lifecycle log.
const SHOW_LOG_COMMAND = 'sisDev.showLog';

export class SisLuaSyntaxServer implements vscode.Disposable {
	// `currentClient` tracks the language-client that an in-flight or
	// running `doStart` invocation owns. Set BEFORE `client.start()` so
	// the onDidChangeState callback can react to Starting/Running/Stopped
	// transitions that fire DURING the start() call. `client` is
	// strictly the post-start handle used by `tokenize()` and the
	// guard checks; it's only assigned after start() resolves
	// successfully.
	private currentClient: LanguageClient | undefined;
	private client: LanguageClient | undefined;
	private startedFor: StartInfo | undefined;
	private disposed = false;

	// All start/stop/restart operations chain through this so we can't
	// race. Callers of `tokenize()` bypass the chain because they only
	// read `this.client`.
	private lifecycle: Promise<void> = Promise.resolve();

	private status: LspStatus = { kind: 'idle' };
	private statusBar: vscode.StatusBarItem;
	private clientStateSub: vscode.Disposable | undefined;
	// Reasons we've already surfaced via showWarningMessage this session.
	// Keeps us from nagging the user every time a lifecycle restart
	// hits the same wall.
	private notifiedReasons = new Set<string>();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.statusBar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			// Slightly left-biased priority so this sits near the
			// OpenHint item (which uses default 0).
			99,
		);
		this.statusBar.command = SHOW_LOG_COMMAND;
		this.statusBar.name = 'SiS Lua LSP';
		context.subscriptions.push(this.statusBar);

		context.subscriptions.push(
			vscode.commands.registerCommand(SHOW_LOG_COMMAND, () => Logger.show()),
		);

		this.renderStatus();
	}

	dispose(): void {
		this.disposed = true;
		this.clientStateSub?.dispose();
		this.clientStateSub = undefined;
		// Fire-and-forget; VS Code deactivation is best-effort.
		void this.stop();
	}

	isRunning(): boolean {
		return !!this.client && !this.disposed;
	}

	// Public lifecycle entry points. All serialize through `lifecycle`.

	start(): Promise<void> {
		return this.enqueue(() => this.doStart());
	}

	stop(): Promise<void> {
		return this.enqueue(() => this.doStop());
	}

	restart(): Promise<void> {
		return this.enqueue(async () => {
			await this.doStop();
			await this.doStart();
		});
	}

	private enqueue(op: () => Promise<void>): Promise<void> {
		const next = this.lifecycle.then(op, op);
		// Keep the chain swallowing errors so a single failed op doesn't
		// poison every future one.
		this.lifecycle = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async doStart(): Promise<void> {
		if (this.disposed) return;

		L.trace('doStart: enter');
		const lookup = resolveStartInfo();
		if (!lookup.info) {
			const reason = lookup.reason ?? 'no startup info';
			L.info('sis_headless -lsp not started:', reason);
			if (lookup.reason && lookup.reason.startsWith('no sis_headless executable')) {
				this.setStatus({ kind: 'unavailable', reason });
				this.notifyOnce(
					'no-exe',
					'SiS Lua diagnostics are off: no sis_headless executable found in the workspace. Build x64/Release/sis_headless.exe or set `sisDev.luaSyntaxDiagnostics.sisHeadlessPath`.',
				);
			} else {
				// workspace just isn't SiS-shaped - stay quiet, the
				// dormant-workspace notification in `activate()`
				// already covers this case.
				this.setStatus({ kind: 'idle' });
			}
			return;
		}
		const info = lookup.info;

		// Already running with the same exe + cwd? Nothing to do.
		if (
			this.client &&
			this.startedFor &&
			this.startedFor.executable === info.executable &&
			this.startedFor.cwd === info.cwd
		) {
			return;
		}

		// Running but with different parameters: tear down cleanly first.
		if (this.client) {
			await this.doStop();
			if (this.disposed) return;
		}

		L.trace('doStart: resolved info', info);
		this.setStatus({ kind: 'starting', info });

		// On Windows we stage the canonical exe into a tempdir before
		// handing it to LanguageClient. The image-load lock then sits
		// on the copy, freeing the canonical path for incremental
		// rebuilds. Linux/macOS have no image-load lock, so we spawn
		// the canonical binary directly.
		let executable: string;
		if (process.platform === 'win32') {
			sweepOldStagingDirs();
			const staged = stageSisHeadlessForLsp(info.executable);
			if (!staged.stagedExe) {
				const reason = staged.error ?? 'unknown staging error';
				L.error('sis_headless -lsp not started: staging failed', reason);
				this.setStatus({ kind: 'failed', reason: `staging failed: ${reason}` });
				this.notifyOnce(
					'staging-failed',
					`SiS Lua diagnostics failed to start: couldn't stage sis_headless to TEMP (${reason}).`,
				);
				return;
			}
			executable = staged.stagedExe;
			L.trace('doStart: staged exe', executable);
		} else {
			executable = info.executable;
		}

		const serverOptions: ServerOptions = {
			command: executable,
			args: ['-lsp'],
			// NOTE: do NOT set `transport: TransportKind.stdio` here. In the
			// `Executable` branch of `vscode-languageclient`, stdio is
			// already the default when `transport` is omitted, AND setting
			// it explicitly causes the client to append `--stdio` to the
			// child's argv (see `lib/node/main.js:410-411`). `sis_headless`
			// does swallow `--stdio` as a no-op (see `headless_main.cpp`),
			// but omitting the transport here keeps the child's argv
			// minimal and avoids relying on that compatibility shim.
			options: {
				cwd: info.cwd,
			},
		};

		const traceVerbose = (process.env.SIS_DEV_LOG_LEVEL ?? '').toLowerCase() === 'trace';
		const clientOptions: LanguageClientOptions = {
			documentSelector: [{ language: 'lua', scheme: 'file' }],
			// A dedicated output channel so users (and Sven) can inspect
			// what the server actually said during startup failures.
			// This is separate from our "SiS Dev" channel: that one
			// carries extension-side lifecycle traces, this one carries
			// raw protocol traffic and server stderr.
			outputChannelName: 'SiS Lua LSP',
		};

		const client = new LanguageClient(
			'sisLuaLsp',
			'SiS Lua LSP',
			serverOptions,
			clientOptions,
		);

		// Verbose tracing when SIS_DEV_LOG_LEVEL=trace. Logs every
		// inbound and outbound JSON-RPC message to the "SiS Lua LSP"
		// output channel, which is invaluable for diagnosing a stuck
		// `client.start()` (you can see exactly which request the
		// languageclient is still waiting on a response for).
		if (traceVerbose) {
			client.setTrace(Trace.Verbose).catch(() => {
				// non-fatal; trace is a diagnostic nicety
			});
		}

		// Publish to `currentClient` BEFORE `client.start()` so the state
		// listener below can react to the Stopped->Starting->Running
		// transitions that fire while `start()` is in flight. Previously
		// we gated the callback on `this.client === client`, but
		// `this.client` was only assigned AFTER start() returned - so
		// every state event during startup was silently dropped, making
		// a hung `start()` invisible to the status surface.
		this.currentClient = client;

		this.clientStateSub?.dispose();
		this.clientStateSub = client.onDidChangeState((e) => {
			if (this.disposed || this.currentClient !== client) return;
			L.trace('client state change', LcState[e.oldState], '->', LcState[e.newState]);
			switch (e.newState) {
				case LcState.Starting:
					this.setStatus({ kind: 'starting', info });
					break;
				case LcState.Running:
					this.setStatus({ kind: 'running', info });
					break;
				case LcState.Stopped:
					// Distinguish "we asked it to stop" from "it died".
					// `doStop` clears `currentClient` first; if we still own
					// this client here, the stop was unsolicited (the
					// languageclient gave up after its built-in restart
					// budget, or `sis_headless` crashed). Clear our
					// references so a subsequent `start()` will attempt a
					// fresh spawn.
					L.warn('sis_headless -lsp transitioned to Stopped unexpectedly');
					this.currentClient = undefined;
					this.client = undefined;
					this.startedFor = undefined;
					this.setStatus({ kind: 'failed', reason: 'LSP server stopped' });
					this.notifyOnce(
						'unexpected-stop',
						'SiS Lua diagnostics stopped: the LSP server died or never finished initializing. Open the SiS Lua LSP output channel for protocol details.',
					);
					break;
			}
		});

		L.trace('doStart: awaiting client.start()...');
		try {
			await this.startWithTimeout(client);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			L.error('sis_headless -lsp failed to start', reason);
			this.setStatus({ kind: 'failed', reason });
			this.notifyOnce(
				`init-failed:${reason}`,
				`SiS Lua diagnostics failed to start: ${reason}. See the SiS Lua LSP output channel for protocol details.`,
			);
			// Ensure no zombie child survives a failed init handshake.
			if (this.currentClient === client) this.currentClient = undefined;
			try {
				await client.stop();
			} catch {
				// already half-dead; nothing to do
			}
			this.clientStateSub?.dispose();
			this.clientStateSub = undefined;
			return;
		}

		// `dispose()` can race with `client.start()` (user closes the
		// window during the ~1s cold boot). Don't publish the client to
		// our state in that case; tear it down instead.
		if (this.disposed) {
			try {
				await client.stop();
			} catch {
				// dispose path; nothing to do
			}
			return;
		}

		this.client = client;
		this.startedFor = info;
		this.setStatus({ kind: 'running', info });
		L.info('sis_headless -lsp started', info);
	}

	// Wrap `client.start()` in a watchdog. If the languageclient's
	// initialize handshake doesn't complete inside `CLIENT_START_TIMEOUT_MS`,
	// give up and surface a visible failure instead of leaving the user
	// staring at a spinning status bar forever.
	private startWithTimeout(client: LanguageClient): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(
					new Error(
						`client.start() did not complete within ${CLIENT_START_TIMEOUT_MS} ms`,
					),
				);
			}, CLIENT_START_TIMEOUT_MS);
			client.start().then(
				() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve();
				},
				(err: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(
						err instanceof Error
							? err
							: new Error(util.inspect(err, { depth: 2 })),
					);
				},
			);
		});
	}

	private async doStop(): Promise<void> {
		// Stop whichever client is currently active. During startup the
		// post-start handle (`this.client`) is still undefined - but the
		// in-flight client lives on `this.currentClient`, and we want to
		// be able to tear that down too (e.g. when an init handshake
		// times out).
		const client = this.client ?? this.currentClient;
		this.client = undefined;
		this.currentClient = undefined;
		this.startedFor = undefined;
		this.clientStateSub?.dispose();
		this.clientStateSub = undefined;
		if (!client) {
			// Idle -> idle; preserve any non-running status (e.g.
			// 'unavailable') the caller asked us to display.
			if (this.status.kind === 'running' || this.status.kind === 'starting') {
				this.setStatus({ kind: 'stopped' });
			}
			return;
		}
		try {
			await client.stop();
		} catch (err) {
			L.warn('sis_headless -lsp stop failed', err);
		}
		if (!this.disposed) this.setStatus({ kind: 'stopped' });
	}

	private setStatus(s: LspStatus): void {
		this.status = s;
		this.renderStatus();
	}

	// Render the current state into the status-bar item. The tooltip
	// holds the gory details (paths, error strings); the visible text
	// stays terse.
	private renderStatus(): void {
		const s = this.status;
		const bar = this.statusBar;
		// Reset error background; we re-apply it for failure states.
		bar.backgroundColor = undefined;

		switch (s.kind) {
			case 'idle':
				bar.hide();
				return;
			case 'stopped':
				bar.text = '$(circle-slash) SiS Lua';
				bar.tooltip = 'SiS Lua LSP stopped. Click to show the SiS Dev log.';
				bar.show();
				return;
			case 'starting':
				bar.text = '$(sync~spin) SiS Lua';
				bar.tooltip = `Starting sis_headless -lsp...\n  exe: ${s.info.executable}\n  cwd: ${s.info.cwd}`;
				bar.show();
				return;
			case 'running':
				bar.text = '$(check) SiS Lua';
				bar.tooltip = `SiS Lua LSP running.\n  exe: ${s.info.executable}\n  cwd: ${s.info.cwd}\nClick to show the SiS Dev log.`;
				bar.show();
				return;
			case 'unavailable':
				bar.text = '$(warning) SiS Lua';
				bar.tooltip = `SiS Lua LSP unavailable: ${s.reason}.\nClick to show the SiS Dev log.`;
				bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				bar.show();
				return;
			case 'failed':
				bar.text = '$(error) SiS Lua';
				bar.tooltip = `SiS Lua LSP failed: ${s.reason}.\nClick to show the SiS Dev log.`;
				bar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
				bar.show();
				return;
		}
	}

	// One-shot notification per reason key. Offers a "Show Logs" action
	// that reveals the "SiS Dev" output channel. We deliberately don't
	// nag again for the same reason in the same session - lifecycle
	// retries from config changes would otherwise re-pop the toast.
	private notifyOnce(reasonKey: string, message: string): void {
		if (this.notifiedReasons.has(reasonKey)) return;
		this.notifiedReasons.add(reasonKey);
		void vscode.window.showWarningMessage(message, 'Show Logs').then((choice) => {
			if (choice === 'Show Logs') Logger.show();
		});
	}

	// `tokenize` is the one feature not already covered by the LSP
	// standard set. The Definition provider calls it opportunistically
	// (`startIfNeeded=false`) - when the server happens to be running
	// it gets dialect-accurate tokens from `sis_lua_tokenize` in
	// `core/lua_state.cpp`; otherwise it falls back to the TS tokenizer.
	//
	// We also allow `startIfNeeded=true` as a convenience for future
	// callers, but the provider intentionally doesn't use it.
	async tokenize(
		document: vscode.TextDocument,
		startIfNeeded: boolean = true,
	): Promise<SisLuaToken[] | undefined> {
		if (!this.client) {
			if (!startIfNeeded) return undefined;
			await this.start();
			if (!this.client) return undefined;
		}

		const text = document.getText();
		if (text.length > MAX_TEXT_CHARS) return [];

		const chunkname = `=${document.fileName}`;
		let response: { tokens?: unknown[] };
		try {
			response = await this.client.sendRequest('sis/tokenize', { text, chunkname });
		} catch (err) {
			L.trace('sis/tokenize request failed', err);
			return undefined;
		}

		const tokens = response?.tokens;
		if (!Array.isArray(tokens)) return [];

		const out: SisLuaToken[] = [];
		for (const t of tokens) {
			const tt = t as Record<string, unknown>;
			const kind = tt.kind;
			const tokText = tt.text;
			const offset = tt.offset;
			const atLineStart = tt.atLineStart;
			if (kind !== 'identifier' && kind !== 'keyword' && kind !== 'punct' && kind !== 'number') continue;
			if (typeof tokText !== 'string') continue;
			if (typeof offset !== 'number') continue;
			if (typeof atLineStart !== 'boolean') continue;
			const line = typeof tt.line === 'number' ? tt.line : undefined;
			out.push({ kind, text: tokText, offset, atLineStart, line });
		}
		return out;
	}
}
