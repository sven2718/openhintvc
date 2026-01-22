import * as vscode from 'vscode';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Logger from '../utils/Logger';

const L = Logger.getLogger('LuaDefinitionProvider');

const MAX_WORKSPACE_RESULTS = 64;
const DEBUG_REQUEST_TIMEOUT_MS = 250;

function isLuaIdentifierStart(ch: string): boolean {
	return /[A-Za-z_]/.test(ch);
}

function isLuaIdentifierChar(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch);
}

function isLuaIdentifierChainChar(ch: string): boolean {
	return isLuaIdentifierChar(ch) || ch === '.' || ch === ':';
}

function asLuaIdentifierChain(value: string): string | undefined {
	const candidate = value.trim();
	if (!candidate) return undefined;

	if (!isLuaIdentifierStart(candidate[0])) return undefined;

	for (let i = 0; i < candidate.length; i++) {
		const ch = candidate[i];
		if (ch === '.' || ch === ':') {
			if (i === 0 || i + 1 >= candidate.length) return undefined;
			if (!isLuaIdentifierStart(candidate[i + 1])) return undefined;
			continue;
		}

		if (!isLuaIdentifierChar(ch)) return undefined;
	}

	return candidate;
}

function getLuaIdentifierChainAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position,
): { text: string; expressionText: string } | undefined {
	const lineText = document.lineAt(position.line).text;
	if (!lineText) return undefined;

	let start = Math.min(position.character, lineText.length);
	let end = start;

	while (start > 0 && isLuaIdentifierChainChar(lineText[start - 1])) {
		start--;
	}
	while (end < lineText.length && isLuaIdentifierChainChar(lineText[end])) {
		end++;
	}

	let raw = lineText.slice(start, end);
	while (raw.length > 0 && (raw[0] === '.' || raw[0] === ':')) raw = raw.slice(1);
	while (raw.length > 0 && (raw[raw.length - 1] === '.' || raw[raw.length - 1] === ':')) raw = raw.slice(0, -1);

	const chain = asLuaIdentifierChain(raw);
	if (!chain) return undefined;

	// For runtime lookup, treat `a:b` as `a.b`.
	const expressionText = chain.replace(/:/g, '.');
	return { text: chain, expressionText };
}

function escapeRegExp(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function luaChainToRegex(text: string): string {
	const parts = text.split(/[.:]/g).filter((x) => x.length > 0);
	return parts.map(escapeRegExp).join('[.:]');
}

function lastLuaNamePart(text: string): string {
	const parts = text.split(/[.:]/g).filter((x) => x.length > 0);
	return parts.length > 0 ? parts[parts.length - 1] : text;
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const handle = setTimeout(() => reject(new Error('timeout')), timeoutMs);
		Promise.resolve(promise).then(
			(value) => {
				clearTimeout(handle);
				resolve(value);
			},
			(err) => {
				clearTimeout(handle);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

async function getTopFrameId(session: vscode.DebugSession): Promise<number | undefined> {
	try {
		const stack = (await withTimeout(
			session.customRequest('stackTrace', { threadId: 0, startFrame: 0, levels: 1 }),
			DEBUG_REQUEST_TIMEOUT_MS,
		)) as { stackFrames?: Array<{ id?: number }> };

		const frameId = stack?.stackFrames?.[0]?.id;
		return typeof frameId === 'number' ? frameId : undefined;
	} catch {
		return undefined;
	}
}

async function evaluateInDebugSession(
	session: vscode.DebugSession,
	expression: string,
	frameId: number | undefined,
): Promise<string | undefined> {
	try {
		const args: any = { expression };
		if (typeof frameId === 'number') args.frameId = frameId;

		const response = (await withTimeout(
			session.customRequest('evaluate', args),
			DEBUG_REQUEST_TIMEOUT_MS,
		)) as { result?: string };

		return typeof response?.result === 'string' ? response.result : undefined;
	} catch {
		return undefined;
	}
}

function stripLuaDebuggeeQuotes(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function isWindowsAbsolutePath(p: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(p);
}

function resolveLuaSourceToUri(source: string): vscode.Uri | undefined {
	const normalized = source.replace(/\\/g, path.sep);

	const tryFile = (fullPath: string): vscode.Uri | undefined => {
		try {
			if (!fs.existsSync(fullPath)) return undefined;
			return vscode.Uri.file(fullPath);
		} catch {
			return undefined;
		}
	};

	if (path.isAbsolute(normalized) || isWindowsAbsolutePath(normalized)) {
		return tryFile(path.normalize(normalized));
	}

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const root = folder.uri.fsPath;
		const candidates = [
			path.join(root, normalized),
			path.join(root, 'resources', normalized),
			path.join(root, 'Lua state', normalized),
			path.join(root, 'resources', 'Lua state', normalized),
		];
		for (const candidate of candidates) {
			const uri = tryFile(candidate);
			if (uri) return uri;
		}
	}

	return undefined;
}

async function tryRuntimeDefinition(
	expressionText: string,
	token: vscode.CancellationToken,
): Promise<vscode.Location | undefined> {
	const session = vscode.debug.activeDebugSession;
	if (!session || session.type !== 'lua') return undefined;
	if (token.isCancellationRequested) return undefined;

	const frameId = await getTopFrameId(session);
	if (typeof frameId !== 'number') return undefined;
	if (token.isCancellationRequested) return undefined;

	const sourceRaw = await evaluateInDebugSession(session, `debug.getinfo(${expressionText}, 'S').source`, frameId);
	const lineRaw = await evaluateInDebugSession(session, `debug.getinfo(${expressionText}, 'S').linedefined`, frameId);
	if (!sourceRaw || !lineRaw) return undefined;

	const source = stripLuaDebuggeeQuotes(sourceRaw).trim();
	const line = Number.parseInt(stripLuaDebuggeeQuotes(lineRaw), 10);
	if (!Number.isFinite(line) || line <= 0) return undefined;

	if (source.startsWith('=')) return undefined;
	const sourcePath = source.startsWith('@') ? source.slice(1) : source;
	if (!sourcePath) return undefined;

	const uri = resolveLuaSourceToUri(sourcePath);
	if (!uri) return undefined;

	return new vscode.Location(uri, new vscode.Position(line - 1, 0));
}

function isProbablyCommentLine(text: string): boolean {
	return text.trimStart().startsWith('--');
}

function scanDocumentForDefinitions(
	document: vscode.TextDocument,
	luaChainRegex: string,
): vscode.Location[] {
	const results: vscode.Location[] = [];
	const functionRe = new RegExp(`\\bfunction\\s+${luaChainRegex}\\s*\\(`);
	const assignRe = new RegExp(`\\b${luaChainRegex}\\s*=\\s*(?:weakMemoize\\d+\\s*\\(\\s*)?function\\s*\\(`);

	for (let i = 0; i < document.lineCount; i++) {
		const line = document.lineAt(i).text;
		if (!line || isProbablyCommentLine(line)) continue;

		if (functionRe.test(line) || assignRe.test(line)) {
			results.push(new vscode.Location(document.uri, new vscode.Position(i, 0)));
		}
	}

	return results;
}

async function findDefinitionsInWorkspace(
	luaChainRegex: string,
	token: vscode.CancellationToken,
): Promise<vscode.Location[]> {
	const results: vscode.Location[] = [];
	const seen = new Set<string>();

	type RgJsonMatch = {
		type: 'match';
		data?: {
			path?: { text?: string };
			line_number?: number;
			submatches?: Array<{ start?: number; end?: number }>;
		};
	};

	let rgAvailable: boolean | undefined = undefined;

	const addResult = (uri: vscode.Uri, line: number, col: number): void => {
		const key = `${uri.toString()}#${line}:${col}`;
		if (seen.has(key)) return;
		seen.add(key);
		results.push(new vscode.Location(uri, new vscode.Position(line, col)));
	};

	const searchWithRipgrep = async (folder: vscode.WorkspaceFolder, pattern: string): Promise<boolean> => {
		if (rgAvailable === false) return false;

		const cwd = folder.uri.fsPath;
		const args = ['--json', '--regexp', pattern, '--glob', '*.lua'];

		return await new Promise<boolean>((resolve) => {
			let child: child_process.ChildProcessWithoutNullStreams | undefined;
			try {
				child = child_process.spawn('rg', args, { cwd });
			} catch {
				rgAvailable = false;
				resolve(false);
				return;
			}

			let buffer = '';

			const stop = (): void => {
				if (!child || child.killed) return;
				try {
					child.kill();
				} catch {
					// ignore
				}
			};

			const onCancel = () => stop();
			token.onCancellationRequested(onCancel);

			child.on('error', (err: any) => {
				if (err?.code === 'ENOENT') {
					rgAvailable = false;
					resolve(false);
					return;
				}
				resolve(true);
			});

			child.stdout.on('data', (chunk: Buffer) => {
				buffer += chunk.toString('utf8');
				while (true) {
					const nl = buffer.indexOf('\n');
					if (nl < 0) break;
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);

					let msg: any;
					try {
						msg = JSON.parse(line);
					} catch {
						continue;
					}

					if (msg?.type !== 'match') continue;
					const match = msg as RgJsonMatch;
					const relPath = match.data?.path?.text;
					const lineNumber = match.data?.line_number;
					if (typeof relPath !== 'string' || typeof lineNumber !== 'number') continue;

					const filePath = path.isAbsolute(relPath) ? relPath : path.join(cwd, relPath);
					const uri = vscode.Uri.file(filePath);

					const submatch = match.data?.submatches?.[0];
					const col = typeof submatch?.start === 'number' ? submatch.start : 0;
					addResult(uri, lineNumber - 1, col);

					if (results.length >= MAX_WORKSPACE_RESULTS) {
						stop();
						return;
					}
				}
			});

			child.on('close', (code) => {
				if (typeof code === 'number' && code !== 0 && code !== 1) {
					L.trace('rg exited with code', code);
				}
				rgAvailable = rgAvailable ?? true;
				resolve(true);
			});
		});
	};

	const searchByScanningFiles = async (folder: vscode.WorkspaceFolder, pattern: string): Promise<void> => {
		const include = new vscode.RelativePattern(folder, '**/*.lua');
		const exclude = new vscode.RelativePattern(folder, '**/node_modules/**');
		const uris = await vscode.workspace.findFiles(include, exclude, undefined, token);

		const re = new RegExp(pattern);
		const decoder = new TextDecoder('utf-8');

		for (const uri of uris) {
			if (token.isCancellationRequested) return;
			if (results.length >= MAX_WORKSPACE_RESULTS) return;

			let text: string;
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				text = decoder.decode(bytes);
			} catch {
				continue;
			}

			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				const lineText = lines[i];
				if (!lineText || isProbablyCommentLine(lineText)) continue;
				const m = re.exec(lineText);
				if (!m) continue;

				addResult(uri, i, m.index ?? 0);
				if (results.length >= MAX_WORKSPACE_RESULTS) return;
			}
		}
	};

	const search = async (pattern: string): Promise<void> => {
		if (results.length >= MAX_WORKSPACE_RESULTS) return;
		if (token.isCancellationRequested) return;

		const folders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of folders) {
			if (token.isCancellationRequested) return;
			if (results.length >= MAX_WORKSPACE_RESULTS) return;

			const ok = await searchWithRipgrep(folder, pattern);
			if (ok) continue;

			// Fallback when `rg` isn't available on PATH (slow).
			await searchByScanningFiles(folder, pattern);
		}
	};

	const patterns = [
		`\\bfunction\\s+${luaChainRegex}\\s*\\(`,
		`\\b${luaChainRegex}\\s*=\\s*(?:weakMemoize\\d+\\s*\\(\\s*)?function\\s*\\(`,
	];

	for (const pattern of patterns) {
		if (token.isCancellationRequested) break;
		await search(pattern);
	}

	return results;
}

class LuaDefinitionProvider implements vscode.DefinitionProvider {
	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Definition | undefined> {
		const chain = getLuaIdentifierChainAtPosition(document, position);
		if (!chain) return undefined;

		const chainRegex = luaChainToRegex(chain.text);
		const localHits = scanDocumentForDefinitions(document, chainRegex);
		if (localHits.length > 0) return localHits;

		const runtime = await tryRuntimeDefinition(chain.expressionText, token);
		if (runtime) return runtime;

		const hits = await findDefinitionsInWorkspace(chainRegex, token);
		if (hits.length > 0) return hits;

		const baseName = lastLuaNamePart(chain.text);
		const suffixRegex = `[A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*[.:]${escapeRegExp(baseName)}`;
		const suffixHits = await findDefinitionsInWorkspace(suffixRegex, token);
		if (suffixHits.length > 0) return suffixHits;

		L.trace('no definition found', chain.text);
		return undefined;
	}
}

export function registerLuaDefinitionProvider(context: vscode.ExtensionContext): void {
	L.trace('registerLuaDefinitionProvider');
	const provider = new LuaDefinitionProvider();
	context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'lua' }, provider));
}
