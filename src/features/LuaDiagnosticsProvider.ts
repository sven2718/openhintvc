import * as vscode from 'vscode';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import Logger from '../utils/Logger';

const L = Logger.getLogger('LuaDiagnosticsProvider');

const PROTOCOL_PREFIX = '@@SIS_LUA_SYNTAX@@';
const SERVER_SCRIPT_REL_PATH = path.join('scripts', 'sis_lua_syntax_server.lua');

const VALIDATE_DEBOUNCE_MS = 250;
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

function getLuaSyntaxDiagnosticsEnabled(): boolean {
	const config = vscode.workspace.getConfiguration('sisDev');
	return config.get<boolean>('luaSyntaxDiagnostics.enabled', true);
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
			candidates.push(path.join(root, 'x64', 'Release', 'sis_headless.exe'));
			candidates.push(path.join(root, 'x64', 'Debug', 'sis_headless.exe'));
		}
	} else {
		for (const root of roots) {
			candidates.push(path.join(root, 'linux', 'build', 'sis_headless'));
			candidates.push(path.join(root, 'build', 'sis_headless'));
		}
	}

	for (const c of candidates) {
		if (fileExists(c)) return c;
	}

	return undefined;
}

type PendingRequest = {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timeout: NodeJS.Timeout;
};

class SisLuaSyntaxServer implements vscode.Disposable {
	private readonly scriptPath: string;
	private child: child_process.ChildProcessWithoutNullStreams | undefined;
	private rl: readline.Interface | undefined;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private startedFor: { executable: string; cwd: string } | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.scriptPath = this.context.asAbsolutePath(SERVER_SCRIPT_REL_PATH);
	}

	dispose(): void {
		this.stop();
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

		if (this.child) {
			try {
				this.child.stdin.end();
			} catch {}
			try {
				this.child.kill();
			} catch {}
			this.child = undefined;
		}

		this.rejectAllPending(new Error('server stopped'));
		this.startedFor = undefined;
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

	private start(executable: string, cwd: string): void {
		this.stop();
		this.startedFor = { executable, cwd };

		L.trace('starting sis lua syntax server', { executable, cwd, scriptPath: this.scriptPath });

		this.child = child_process.spawn(executable, [this.scriptPath], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this.child.on('exit', (code, signal) => {
			L.trace('sis lua syntax server exited', { code, signal });
			this.child = undefined;
			this.rejectAllPending(new Error('server exited'));
		});

		this.child.on('error', (err) => {
			L.trace('sis lua syntax server error', err);
			this.child = undefined;
			this.rejectAllPending(err instanceof Error ? err : new Error(String(err)));
		});

		this.rl = readline.createInterface({ input: this.child.stdout });
		this.rl.on('line', (line) => this.onStdoutLine(line));
	}

	private ensureStartedForDocument(document: vscode.TextDocument): boolean {
		const folder = vscode.workspace.getWorkspaceFolder(document.uri);
		const folderPath = folder?.uri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
		if (!folderPath) return false;

		const cwd = findLuaStateCwd(folderPath);
		if (!cwd) return false;

		const executable = findSisHeadlessExecutable(folderPath);
		if (!executable) return false;

		if (this.child && this.startedFor?.executable === executable && this.startedFor?.cwd === cwd) {
			return true;
		}

		this.start(executable, cwd);
		return true;
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

	async checkSyntax(document: vscode.TextDocument): Promise<vscode.Diagnostic[] | undefined> {
		if (!this.ensureStartedForDocument(document)) {
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
}

class LuaSyntaxDiagnostics implements vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;
	private readonly server: SisLuaSyntaxServer;
	private readonly timers = new Map<string, NodeJS.Timeout>();

	constructor(context: vscode.ExtensionContext) {
		this.collection = vscode.languages.createDiagnosticCollection('sisLuaSyntax');
		this.server = new SisLuaSyntaxServer(context);
	}

	dispose(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		this.collection.dispose();
		this.server.dispose();
	}

	clear(document: vscode.TextDocument): void {
		this.collection.delete(document.uri);
	}

	schedule(document: vscode.TextDocument): void {
		if (document.languageId !== 'lua') return;
		if (document.uri.scheme !== 'file') return;

		if (!getLuaSyntaxDiagnosticsEnabled()) {
			this.clear(document);
			this.server.stop();
			return;
		}

		const key = document.uri.toString();
		const existing = this.timers.get(key);
		if (existing) clearTimeout(existing);

		const expectedVersion = document.version;
		const handle = setTimeout(() => {
			this.timers.delete(key);
			void this.validate(document.uri, expectedVersion);
		}, VALIDATE_DEBOUNCE_MS);

		this.timers.set(key, handle);
	}

	private async validate(uri: vscode.Uri, expectedVersion: number): Promise<void> {
		if (!getLuaSyntaxDiagnosticsEnabled()) {
			this.collection.delete(uri);
			this.server.stop();
			return;
		}

		const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		if (!document) return;
		if (document.version !== expectedVersion) return;

		let diagnostics: vscode.Diagnostic[] | undefined;
		try {
			diagnostics = await this.server.checkSyntax(document);
		} catch (err) {
			L.trace('syntax check failed', err);
			diagnostics = undefined;
		}

		const liveDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		if (!liveDoc) return;
		if (liveDoc.version !== expectedVersion) return;

		if (diagnostics) {
			this.collection.set(uri, diagnostics);
		} else {
			this.collection.delete(uri);
		}
	}
}

export function registerLuaDiagnosticsProvider(context: vscode.ExtensionContext): void {
	const diagnostics = new LuaSyntaxDiagnostics(context);
	context.subscriptions.push(diagnostics);

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((doc) => diagnostics.schedule(doc)),
		vscode.workspace.onDidSaveTextDocument((doc) => diagnostics.schedule(doc)),
		vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clear(doc)),
		vscode.workspace.onDidChangeTextDocument((e) => diagnostics.schedule(e.document)),
	);

	for (const doc of vscode.workspace.textDocuments) {
		diagnostics.schedule(doc);
	}
}
