import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
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
//    the exe + sibling DLLs into `%TEMP%/sis_headless_lsp/<key>/` and
//    returns the staged path; we hand THAT to `LanguageClient`. The Python
//    launcher under `tools/sis_headless_lsp_launcher.py` does the same
//    dance for non-VS Code clients (Crush, etc.). On Linux/macOS there is
//    no image-load lock, so we spawn the canonical binary directly.
//
//  - **Optional startup.** Constructor does not auto-start. The
//    extension activation layer decides when to `start()` based on
//    `sisDev.luaSyntaxDiagnostics.enabled`, workspace shape, and exe
//    availability.

const L = Logger.getLogger('SisLuaSyntaxServer');

const MAX_TEXT_CHARS = 1024 * 1024;

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
// Mirror of `tools/sis_headless_lsp_launcher.py`: copy `sis_headless` and
// its sibling DLLs into `%TEMP%/sis_headless_lsp/<key>/` and return the
// staged path. <key> is a short hash of the source path so two checkouts
// on the same machine don't collide. We re-stage when the source's
// `size` + `mtimeMs` no longer match the recorded stamp, and skip the
// copy otherwise (so warm restarts cost ~one stat call).
//
// The canonical exe is never spawned directly, which keeps it free for
// `link.exe /OUT:<exe>` during incremental rebuilds.

const STAGING_ROOT_NAME = 'sis_headless_lsp';
const STAGING_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

function stagingRoot(): string {
	return path.join(os.tmpdir(), STAGING_ROOT_NAME);
}

function stagingDirFor(sourceExe: string): string {
	const key = crypto.createHash('sha1').update(sourceExe).digest('hex').slice(0, 16);
	return path.join(stagingRoot(), key);
}

interface StageStamp {
	size: number;
	mtimeMs: number;
}

function readStamp(stampPath: string): StageStamp | undefined {
	try {
		const raw = fs.readFileSync(stampPath, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<StageStamp>;
		if (typeof parsed.size === 'number' && typeof parsed.mtimeMs === 'number') {
			return { size: parsed.size, mtimeMs: parsed.mtimeMs };
		}
	} catch {
		// stamp missing or unreadable; treat as stale
	}
	return undefined;
}

// Best-effort cleanup: remove sibling staging dirs whose mtime is older
// than `STAGING_SWEEP_AGE_MS`. A dir whose exe is currently held open by
// another LSP child will fail to delete; we silently move on and rely on
// a future sweep.
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

// Returns the staged exe path on success, or `undefined` if staging
// failed for any reason (in which case the caller can either fall back
// to the canonical path or just refuse to start).
function stageSisHeadlessForLsp(sourceExe: string): string | undefined {
	const absSource = path.resolve(sourceExe);
	const stagingDir = stagingDirFor(absSource);
	const stagedExe = path.join(stagingDir, path.basename(absSource));
	const stampPath = path.join(stagingDir, 'stamp.json');

	let srcStat: fs.Stats;
	try {
		srcStat = fs.statSync(absSource);
	} catch (err) {
		L.trace('stageSisHeadlessForLsp: source stat failed', err);
		return undefined;
	}
	const srcStamp: StageStamp = { size: srcStat.size, mtimeMs: srcStat.mtimeMs };

	const cached = readStamp(stampPath);
	if (cached && cached.size === srcStamp.size && cached.mtimeMs === srcStamp.mtimeMs && fileExists(stagedExe)) {
		return stagedExe;
	}

	try {
		fs.mkdirSync(stagingDir, { recursive: true });
		fs.copyFileSync(absSource, stagedExe);
	} catch (err) {
		L.trace('stageSisHeadlessForLsp: copy failed', err);
		return undefined;
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

	try {
		fs.writeFileSync(stampPath, JSON.stringify(srcStamp), 'utf-8');
	} catch {
		// non-fatal: a missing stamp just means we'll re-stage next time
	}

	return stagedExe;
}

// Startup info for a particular workspace folder. We recompute this on
// every lifecycle op so a user toggling `sisHeadlessPath` mid-session
// still takes effect on the next `restart()`.
interface StartInfo {
	executable: string;
	cwd: string;
}

function resolveStartInfo(): StartInfo | undefined {
	const folders = vscode.workspace.workspaceFolders ?? [];
	for (const folder of folders) {
		const folderPath = folder.uri.fsPath;
		const cwd = findLuaStateCwd(folderPath);
		if (!cwd) continue;
		const executable = findSisHeadlessExecutable(folderPath);
		if (!executable) continue;
		return { executable, cwd };
	}
	return undefined;
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

export class SisLuaSyntaxServer implements vscode.Disposable {
	private client: LanguageClient | undefined;
	private startedFor: StartInfo | undefined;
	private disposed = false;

	// All start/stop/restart operations chain through this so we can't
	// race. Callers of `tokenize()` bypass the chain because they only
	// read `this.client`.
	private lifecycle: Promise<void> = Promise.resolve();

	constructor(private readonly context: vscode.ExtensionContext) {}

	dispose(): void {
		this.disposed = true;
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

		const info = resolveStartInfo();
		if (!info) {
			// Either no SiS-shaped workspace, or no exe. Just leave the
			// server offline; the Definition provider's opportunistic
			// `tokenize(doc, startIfNeeded=false)` calls will return
			// undefined and fall back to the TS tokenizer.
			L.trace('sis_headless -lsp not started: no suitable workspace or exe');
			return;
		}

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

		// On Windows we stage the canonical exe into a tempdir before
		// handing it to LanguageClient. The image-load lock then sits
		// on the copy, freeing the canonical path for incremental
		// rebuilds. Linux/macOS have no image-load lock, so we spawn
		// the canonical binary directly.
		let executable: string;
		if (process.platform === 'win32') {
			sweepOldStagingDirs();
			const staged = stageSisHeadlessForLsp(info.executable);
			if (!staged) {
				L.trace('sis_headless -lsp not started: staging to tempdir failed', info);
				return;
			}
			executable = staged;
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

		const clientOptions: LanguageClientOptions = {
			documentSelector: [{ language: 'lua', scheme: 'file' }],
			// A dedicated output channel so users (and Sven) can inspect
			// what the server actually said during startup failures.
			outputChannelName: 'SiS Lua LSP',
		};

		const client = new LanguageClient(
			'sisLuaLsp',
			'SiS Lua LSP',
			serverOptions,
			clientOptions,
		);

		try {
			await client.start();
		} catch (err) {
			L.trace('sis_headless -lsp failed to start', err);
			// Ensure no zombie child survives a failed init handshake.
			try {
				await client.stop();
			} catch {}
			return;
		}

		// `dispose()` can race with `client.start()` (user closes the
		// window during the ~1s cold boot). Don't publish the client to
		// our state in that case; tear it down instead.
		if (this.disposed) {
			try {
				await client.stop();
			} catch {}
			return;
		}

		this.client = client;
		this.startedFor = info;
		L.trace('sis_headless -lsp started', info);
	}

	private async doStop(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		this.startedFor = undefined;
		if (!client) return;
		try {
			await client.stop();
		} catch (err) {
			L.trace('sis_headless -lsp stop failed', err);
		}
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
