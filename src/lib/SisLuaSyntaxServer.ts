import * as vscode from 'vscode';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import Logger from '../utils/Logger';

const L = Logger.getLogger('SisLuaSyntaxServer');

const PROTOCOL_PREFIX = '@@SIS_LUA_SYNTAX@@';
const SERVER_SCRIPT_REL_PATH = path.join('scripts', 'sis_lua_syntax_server.lua');

const REQUEST_TIMEOUT_MS = 2000;
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

function findLuaStateCwd(workspaceFolderPath: string): string | undefined {
	// `sis_headless` requires that the CWD contain "Lua state".
	if (dirExists(path.join(workspaceFolderPath, 'Lua state'))) {
		return workspaceFolderPath;
	}

	// Common mod-kit layout: the workspace itself is `Lua state/`.
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

function isDynamicLibraryFilename(name: string): boolean {
	const lower = name.toLowerCase();
	if (process.platform === 'win32') return lower.endsWith('.dll');
	if (process.platform === 'darwin') return lower.endsWith('.dylib');
	return lower.endsWith('.so') || lower.includes('.so.');
}

function copySiblingDynamicLibraries(sourceExecutable: string, destDir: string): number {
	const sourceDir = path.dirname(sourceExecutable);

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(sourceDir, { withFileTypes: true });
	} catch {
		return 0;
	}

	let copied = 0;
	for (const entry of entries) {
		if (!entry.isFile()) continue;

		const name = entry.name;
		if (!isDynamicLibraryFilename(name)) continue;

		const src = path.join(sourceDir, name);
		const dst = path.join(destDir, name);
		try {
			fs.copyFileSync(src, dst);
			copied++;
		} catch {}
	}

	return copied;
}

type SisHeadlessSnapshot = {
	sourceExecutable: string;
	executable: string;
	tempDir: string;
};

function snapshotSisHeadlessExecutable(sourceExecutable: string): SisHeadlessSnapshot | undefined {
	let tempDir: string | undefined;
	try {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sis-headless-syntax-'));
		const executable = path.join(tempDir, path.basename(sourceExecutable));
		fs.copyFileSync(sourceExecutable, executable);

		try {
			// Preserve + ensure executable bit on POSIX.
			const mode = fs.statSync(sourceExecutable).mode;
			fs.chmodSync(executable, mode | 0o111);
		} catch {}

		const copiedLibs = copySiblingDynamicLibraries(sourceExecutable, tempDir);
		L.trace('snapshotted sis_headless for lua analysis', {
			sourceExecutable,
			executable,
			copiedLibs,
		});

		return { sourceExecutable, executable, tempDir };
	} catch (err) {
		if (tempDir) {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {}
		}
		L.trace('failed to snapshot sis_headless', err);
		return undefined;
	}
}

function findSisHeadlessExecutableAtStartup(): string | undefined {
	const configured = getConfiguredSisHeadlessPath();
	if (configured && fileExists(configured)) return configured;

	const folders = vscode.workspace.workspaceFolders ?? [];
	for (const folder of folders) {
		const exe = findSisHeadlessExecutable(folder.uri.fsPath);
		if (exe) return exe;
	}

	return undefined;
}

type PendingRequest = {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timeout: NodeJS.Timeout;
};

export type SisLuaTokenKind = 'identifier' | 'keyword' | 'punct' | 'number';

export type SisLuaToken = {
	kind: SisLuaTokenKind;
	text: string;
	offset: number;
	atLineStart: boolean;
	line?: number;
};

export class SisLuaSyntaxServer implements vscode.Disposable {
	private readonly scriptPath: string;
	private readonly snapshot: SisHeadlessSnapshot | undefined;
	private child: child_process.ChildProcessWithoutNullStreams | undefined;
	private rl: readline.Interface | undefined;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private startedFor: { executable: string; cwd: string } | undefined;
	private disposed = false;
	private snapshotDeleted = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.scriptPath = this.context.asAbsolutePath(SERVER_SCRIPT_REL_PATH);

		// Snapshot `sis_headless` once at extension startup so developers can rebuild
		// the original binary without fighting file locks.
		const sourceExecutable = findSisHeadlessExecutableAtStartup();
		if (!sourceExecutable) {
			L.trace('sis_headless not found at startup; SiS Lua analysis disabled until VS Code restart');
			this.snapshot = undefined;
		} else {
			this.snapshot = snapshotSisHeadlessExecutable(sourceExecutable);
			if (!this.snapshot) {
				L.trace('sis_headless snapshot failed; SiS Lua analysis disabled until VS Code restart');
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.tryDeleteSnapshotTempDir();
	}

	private rejectAllPending(err: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(err);
		}
		this.pending.clear();
	}

	stop(): void {
		if (this.rl) {
			this.rl.close();
			this.rl = undefined;
		}

		const child = this.child;
		this.child = undefined;
		if (child) {
			try {
				child.stdin.end();
			} catch {}
			try {
				child.kill();
			} catch {}

			if (this.disposed) {
				try {
					child.kill('SIGKILL');
				} catch {}
			}
		}

		this.rejectAllPending(new Error('server stopped'));
		this.startedFor = undefined;
	}

	private tryDeleteSnapshotTempDir(): void {
		if (this.snapshotDeleted) return;
		const tempDir = this.snapshot?.tempDir;
		if (!tempDir) {
			this.snapshotDeleted = true;
			return;
		}

		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
			this.snapshotDeleted = true;
			L.trace('deleted sis_headless snapshot temp dir', { tempDir });
		} catch (err) {
			L.trace('failed to delete sis_headless snapshot temp dir', { tempDir, err });
		}
	}

	private onStdoutLine(line: string): void {
		if (!line.startsWith(PROTOCOL_PREFIX)) return;
		const jsonText = line.slice(PROTOCOL_PREFIX.length);

		let msg: any;
		try {
			msg = JSON.parse(jsonText);
		} catch (err) {
			L.trace('failed to parse server json', err);
			return;
		}

		if (msg?.event === 'ready') {
			L.trace('sis lua syntax server ready', msg?.protocol);
			return;
		}

		const id = msg?.id;
		if (typeof id !== 'number') return;

		const pending = this.pending.get(id);
		if (!pending) return;

		this.pending.delete(id);
		clearTimeout(pending.timeout);

		if (msg?.ok) {
			pending.resolve(msg);
		} else {
			const message = typeof msg?.error?.message === 'string' ? msg.error.message : 'request failed';
			pending.reject(new Error(message));
		}
	}

	private getStartInfoForDocument(document: vscode.TextDocument): { executable: string; cwd: string } | undefined {
		const executable = this.snapshot?.executable;
		if (!executable) return undefined;

		const folder = vscode.workspace.getWorkspaceFolder(document.uri);
		const folderPath = folder?.uri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
		if (!folderPath) return undefined;

		const cwd = findLuaStateCwd(folderPath);
		if (!cwd) return undefined;

		// Server script depends on `resources/debuggee/dkjson.lua`.
		if (!fileExists(path.join(cwd, 'debuggee', 'dkjson.lua'))) return undefined;

		return { executable, cwd };
	}

		private start(executable: string, cwd: string): void {
			this.stop();
			this.startedFor = { executable, cwd };

			L.trace('starting sis lua syntax server', { executable, cwd, scriptPath: this.scriptPath });

			const child = child_process.spawn(executable, [this.scriptPath], {
				cwd,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			this.child = child;

			child.on('exit', (code, signal) => {
				L.trace('sis lua syntax server exited', { code, signal });

				if (this.child === child) {
					this.child = undefined;
					this.startedFor = undefined;
					this.rejectAllPending(new Error('server exited'));
				}

				if (this.disposed) {
					this.tryDeleteSnapshotTempDir();
				}
			});

			child.on('error', (err) => {
				L.trace('sis lua syntax server error', err);

				if (this.child === child) {
					this.child = undefined;
					this.startedFor = undefined;
					this.rejectAllPending(err instanceof Error ? err : new Error(String(err)));
				}

				if (this.disposed) {
					this.tryDeleteSnapshotTempDir();
				}
			});

			this.rl = readline.createInterface({ input: child.stdout });
			this.rl.on('line', (line) => this.onStdoutLine(line));
		}

	private ensureStartedForDocument(document: vscode.TextDocument): boolean {
		const info = this.getStartInfoForDocument(document);
		if (!info) return false;

		if (this.child && this.startedFor?.executable === info.executable && this.startedFor?.cwd === info.cwd) {
			return true;
		}

		this.start(info.executable, info.cwd);
		return true;
	}

	private isStartedForDocument(document: vscode.TextDocument): boolean {
		const info = this.getStartInfoForDocument(document);
		if (!info) return false;
		return !!(this.child && this.startedFor?.executable === info.executable && this.startedFor?.cwd === info.cwd);
	}

	private sendRequest(method: string, params: any): Promise<any> {
		const child = this.child;
		if (!child) {
			return Promise.reject(new Error('server not running'));
		}

		const id = this.nextId++;
		const payload = JSON.stringify({ id, method, params });

		return new Promise<any>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('timeout'));
			}, REQUEST_TIMEOUT_MS);

			this.pending.set(id, { resolve, reject, timeout });

			try {
				child.stdin.write(payload + '\n', 'utf-8');
			} catch (err) {
				clearTimeout(timeout);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	async checkSyntax(document: vscode.TextDocument, startIfNeeded: boolean = true): Promise<vscode.Diagnostic[] | undefined> {
		const ok = startIfNeeded ? this.ensureStartedForDocument(document) : this.isStartedForDocument(document);
		if (!ok) {
			return undefined;
		}

		const text = document.getText();
		if (text.length > MAX_TEXT_CHARS) {
			return [];
		}

		const chunkname = `=${document.fileName}`;

		const msg = await this.sendRequest('check_syntax', { text, chunkname });
		const diagnostics = msg?.result?.diagnostics;
		if (!Array.isArray(diagnostics)) return [];

		const out: vscode.Diagnostic[] = [];
		for (const d of diagnostics) {
			const line1 = typeof d?.line === 'number' ? d.line : 1;
			const lineIndex = Math.max(0, Math.min(document.lineCount - 1, line1 - 1));
			const range = document.lineAt(lineIndex).range;

			const message =
				typeof d?.message === 'string'
					? d.message
					: typeof d?.raw === 'string'
						? d.raw
						: 'syntax error';

			const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
			diag.source = 'SiS Lua parser';
			out.push(diag);
		}

		return out;
	}

	async tokenize(document: vscode.TextDocument, startIfNeeded: boolean = true): Promise<SisLuaToken[] | undefined> {
		const ok = startIfNeeded ? this.ensureStartedForDocument(document) : this.isStartedForDocument(document);
		if (!ok) {
			return undefined;
		}

		const text = document.getText();
		if (text.length > MAX_TEXT_CHARS) {
			return [];
		}

		const chunkname = `=${document.fileName}`;

		const msg = await this.sendRequest('tokenize', { text, chunkname });
		const tokens = msg?.result?.tokens;
		if (!Array.isArray(tokens)) return [];

		const out: SisLuaToken[] = [];
		for (const t of tokens) {
			const kind = t?.kind;
			const tokText = t?.text;
			const offset = t?.offset;
			const atLineStart = t?.atLineStart;

			if (kind !== 'identifier' && kind !== 'keyword' && kind !== 'punct' && kind !== 'number') continue;
			if (typeof tokText !== 'string') continue;
			if (typeof offset !== 'number') continue;
			if (typeof atLineStart !== 'boolean') continue;

			const line = typeof t?.line === 'number' ? t.line : undefined;

			out.push({ kind, text: tokText, offset, atLineStart, line });
		}

		return out;
	}
}
