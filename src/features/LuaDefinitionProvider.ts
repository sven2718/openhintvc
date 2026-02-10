import * as vscode from 'vscode';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Logger from '../utils/Logger';
import { findSisLuaLocalDefinitionOffset, findSisLuaUnqualifiedDefinitionOffsets } from '../lib/SisLua';

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
	// SiS dialect: allow postfix `?`/`!` to stay part of the selection, then strip.
	return isLuaIdentifierChar(ch) || ch === '.' || ch === ':' || ch === '?' || ch === '!';
}

function getLuaIdentifierAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position,
): { name: string; precededByAccessor: boolean } | undefined {
	const lineText = document.lineAt(position.line).text;
	if (!lineText) return undefined;

	const isWordChar = (ch: string): boolean => isLuaIdentifierChar(ch) || ch === '?' || ch === '!';

	let start = Math.min(position.character, lineText.length);
	let end = start;

	while (start > 0 && isWordChar(lineText[start - 1])) {
		start--;
	}
	while (end < lineText.length && isWordChar(lineText[end])) {
		end++;
	}

	let raw = lineText.slice(start, end);
	raw = raw.replace(/[?!]/g, '');

	if (!raw) return undefined;
	if (!isLuaIdentifierStart(raw[0])) return undefined;

	for (let i = 0; i < raw.length; i++) {
		if (!isLuaIdentifierChar(raw[i])) return undefined;
	}

	let j = start - 1;
	while (j >= 0 && (lineText[j] === ' ' || lineText[j] === '\t')) j--;
	const precededByAccessor = j >= 0 && (lineText[j] === '.' || lineText[j] === ':');
	return { name: raw, precededByAccessor };
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

	// SiS dialect: safe navigation / required postfix.
	raw = raw.replace(/[?!]/g, '');

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

	// Avoid `stackTrace`/frame-dependent queries here: the debuggee may not be
	// paused (and may not have a meaningful stack we can inspect).
	const sourceRaw = await evaluateInDebugSession(session, `debug.getinfo(${expressionText}, 'S').source`, undefined);
	const lineRaw = await evaluateInDebugSession(session, `debug.getinfo(${expressionText}, 'S').linedefined`, undefined);
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

function splitLuaChainParts(text: string): string[] {
	return text.split(/[.:]/g).filter((x) => x.length > 0);
}

const SIS_MODULE_PREFIX_TO_DIR: Record<string, string> = {
	action: 'Actions',
	motion_function: 'MotionFunctions',
	gui: 'GUI',
	order: 'Orders',
	drawers: 'Drawers',
	AI: 'AI',
};

function stripSisLuaEnvPrefix(name: string): string {
	return name.replace(/^[@~]+/, '');
}

function detectSisEnvOverrideName(text: string, fileBaseName: string): string | undefined {
	const trimmedBase = stripSisLuaEnvPrefix(fileBaseName);

	const lines = text.split(/\r?\n/);
	const head = lines
		.slice(0, 60)
		.filter((l) => !l.trimStart().startsWith('--'))
		.join('\n');

	const prop = head.match(/_ENV\s*=\s*ensure_property_env\s*\(\s*_ENV\s*(?:,\s*(['"])(.*?)\1)?/);
	if (prop) return prop[2] ?? trimmedBase;

	const fileEnv = head.match(/_ENV\s*=\s*create_file_env\s*\(\s*_ENV\s*(?:,\s*(['"])(.*?)\1)?/);
	if (fileEnv) return fileEnv[2] ?? trimmedBase;

	const ensure = head.match(/_ENV\s*=\s*ensure_env\s*\(\s*(['"])(.*?)\1/);
	if (ensure) return ensure[2];

	return undefined;
}

async function listSisEnvFiles(
	moduleDir: string,
	envKey: string,
	token: vscode.CancellationToken,
): Promise<vscode.Uri[]> {
	const found = new Map<string, vscode.Uri>();
	const exclude = '**/node_modules/**';

	const patterns = [
		`resources/Lua state/${moduleDir}/**/${envKey}.lua`,
		`resources/Lua state/${moduleDir}/**/@${envKey}.lua`,
		`resources/Lua state/${moduleDir}/**/~${envKey}.lua`,
		`Lua state/${moduleDir}/**/${envKey}.lua`,
		`Lua state/${moduleDir}/**/@${envKey}.lua`,
		`Lua state/${moduleDir}/**/~${envKey}.lua`,
	];

	const folders = vscode.workspace.workspaceFolders ?? [];
	for (const folder of folders) {
		for (const pattern of patterns) {
			if (token.isCancellationRequested) return Array.from(found.values());
			const include = new vscode.RelativePattern(folder, pattern);
			let uris: vscode.Uri[] = [];
			try {
				uris = await vscode.workspace.findFiles(include, exclude, 32, token);
			} catch {
				continue;
			}
			for (const uri of uris) found.set(uri.toString(), uri);
		}
	}

	return Array.from(found.values());
}

async function tryResolveSisEnvMemberDefinition(
	modulePrefix: string,
	envKey: string,
	memberName: string | undefined,
	token: vscode.CancellationToken,
): Promise<vscode.Location[] | undefined> {
	const moduleDir = SIS_MODULE_PREFIX_TO_DIR[modulePrefix];
	if (!moduleDir) return undefined;

	const candidates = await listSisEnvFiles(moduleDir, envKey, token);
	if (candidates.length === 0) return undefined;

	for (const uri of candidates) {
		if (token.isCancellationRequested) return undefined;

		let doc: vscode.TextDocument;
		try {
			doc = await vscode.workspace.openTextDocument(uri);
		} catch {
			continue;
		}

		const base = stripSisLuaEnvPrefix(path.parse(uri.fsPath).name);
		const envName = detectSisEnvOverrideName(doc.getText(), base);
		if (envName !== envKey) continue;

		if (!memberName) {
			return [new vscode.Location(uri, new vscode.Position(0, 0))];
		}

		const offsets = findSisLuaUnqualifiedDefinitionOffsets(doc.getText(), memberName);
		if (offsets.length === 0) continue;

		return offsets.map((off) => new vscode.Location(uri, doc.positionAt(off)));
	}

	return undefined;
}

function looksLikeSisEnvOverrideFile(text: string): boolean {
	const lines = text.split(/\r?\n/);
	const head = lines
		.slice(0, 40)
		.filter((l) => !l.trimStart().startsWith('--'))
		.join('\n');
	return /_ENV\s*=/.test(head);
}

async function listLuaFilesWithRipgrep(
	cwd: string,
	pattern: string,
	token: vscode.CancellationToken,
): Promise<vscode.Uri[] | undefined> {
	return await new Promise<vscode.Uri[] | undefined>((resolve) => {
		let child: child_process.ChildProcessWithoutNullStreams | undefined;
		try {
			child = child_process.spawn('rg', ['--files-with-matches', '--regexp', pattern, '--glob', '*.lua'], { cwd });
		} catch {
			resolve(undefined);
			return;
		}

		let out = '';

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
				resolve(undefined);
				return;
			}
			resolve(undefined);
		});

		child.stdout.on('data', (chunk: Buffer) => {
			out += chunk.toString('utf8');
		});

		child.on('close', (code) => {
			if (typeof code === 'number' && code !== 0 && code !== 1) {
				L.trace('rg (files-with-matches) exited with code', code);
			}

			const uris: vscode.Uri[] = [];
			for (const line of out.split(/\r?\n/)) {
				const rel = line.trim();
				if (!rel) continue;
				const full = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
				uris.push(vscode.Uri.file(full));
			}

			resolve(uris);
		});
	});
}

async function tryResolveSisModuleFieldDefinition(
	modulePrefix: string,
	name: string,
	token: vscode.CancellationToken,
): Promise<vscode.Location[] | undefined> {
	const moduleDir = SIS_MODULE_PREFIX_TO_DIR[modulePrefix];
	if (!moduleDir) return undefined;

	const results: vscode.Location[] = [];
	const seen = new Set<string>();
	const add = (loc: vscode.Location): void => {
		const key = `${loc.uri.toString()}#${loc.range.start.line}:${loc.range.start.character}`;
		if (seen.has(key)) return;
		seen.add(key);
		results.push(loc);
	};

	const folders = vscode.workspace.workspaceFolders ?? [];
	const decoder = new TextDecoder('utf-8');

	for (const folder of folders) {
		if (token.isCancellationRequested) break;

		const dirCandidates = [
			path.join(folder.uri.fsPath, 'resources', 'Lua state', moduleDir),
			path.join(folder.uri.fsPath, 'Lua state', moduleDir),
		].filter((p) => {
			try {
				return fs.existsSync(p);
			} catch {
				return false;
			}
		});

		for (const dirPath of dirCandidates) {
			if (token.isCancellationRequested) break;

			const rgUris = await listLuaFilesWithRipgrep(dirPath, `\\b${escapeRegExp(name)}\\b`, token);
			let fileUris: vscode.Uri[] = [];

			if (rgUris) {
				fileUris = rgUris;
			} else {
				const include = new vscode.RelativePattern(vscode.Uri.file(dirPath), '**/*.lua');
				try {
					fileUris = await vscode.workspace.findFiles(include, '**/node_modules/**', undefined, token);
				} catch {
					fileUris = [];
				}
			}

			for (const uri of fileUris) {
				if (token.isCancellationRequested) break;
				if (results.length >= MAX_WORKSPACE_RESULTS) break;

				let bytes: Uint8Array;
				try {
					bytes = await vscode.workspace.fs.readFile(uri);
				} catch {
					continue;
				}

				const text = decoder.decode(bytes);
				if (looksLikeSisEnvOverrideFile(text)) continue;

				const offsets = findSisLuaUnqualifiedDefinitionOffsets(text, name);
				if (offsets.length === 0) continue;

				let doc: vscode.TextDocument;
				try {
					doc = await vscode.workspace.openTextDocument(uri);
				} catch {
					continue;
				}

				for (const off of offsets) {
					add(new vscode.Location(uri, doc.positionAt(off)));
					if (results.length >= MAX_WORKSPACE_RESULTS) break;
				}
			}
		}
	}

	return results.length > 0 ? results : undefined;
}

function tryLocalSymbolDefinition(
	document: vscode.TextDocument,
	position: vscode.Position,
	name: string,
): vscode.Definition | undefined {
	const text = document.getText();
	const cutoff = document.offsetAt(position);
	const localOff = findSisLuaLocalDefinitionOffset(text, cutoff, name);
	if (typeof localOff === 'number') {
		return new vscode.Location(document.uri, document.positionAt(localOff));
	}

	const offsets = findSisLuaUnqualifiedDefinitionOffsets(text, name);
	if (offsets.length > 0) return offsets.map((off) => new vscode.Location(document.uri, document.positionAt(off)));

	return undefined;
}

function scanDocumentForDefinitions(
	document: vscode.TextDocument,
	luaChainRegex: string,
): vscode.Location[] {
	const results: vscode.Location[] = [];
	const functionRe = new RegExp(`\\bfunction\\s+${luaChainRegex}\\s*\\(`);
	const assignRe = new RegExp(`\\b${luaChainRegex}\\s*=\\s*(?:weakMemoize\\d+\\s*\\(\\s*)?function\\s*\\(`);
	const valueAssignRe = new RegExp(`\\b${luaChainRegex}\\s*=`);

	for (let i = 0; i < document.lineCount; i++) {
		const line = document.lineAt(i).text;
		if (!line || isProbablyCommentLine(line)) continue;

		if (functionRe.test(line) || assignRe.test(line) || valueAssignRe.test(line)) {
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
		`\\b${luaChainRegex}\\s*=`,
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
		const localCandidate = getLuaIdentifierAtPosition(document, position);
		if (localCandidate && !localCandidate.precededByAccessor) {
			// Prefer locals/upvalues even when used as the base of a member chain
			// (e.g. `ship.empire` should jump to the `ship` loop var / param).
			const text = document.getText();
			const cutoff = document.offsetAt(position);

			const localOff = findSisLuaLocalDefinitionOffset(text, cutoff, localCandidate.name);
			if (typeof localOff === 'number') {
				return new vscode.Location(document.uri, document.positionAt(localOff));
			}

			// `_ENV` is an implicit upvalue in Lua 5.2 chunks; treat the nearest
			// assignment as its "definition" for navigation purposes.
			if (localCandidate.name === '_ENV') {
				const offs = findSisLuaUnqualifiedDefinitionOffsets(text, '_ENV').filter((off) => off < cutoff);
				if (offs.length > 0) {
					const best = offs.reduce((a, b) => (a > b ? a : b));
					return new vscode.Location(document.uri, document.positionAt(best));
				}
			}
		}

		const chain = getLuaIdentifierChainAtPosition(document, position);
		if (!chain) return undefined;

		const parts = splitLuaChainParts(chain.text);
		if (parts.length === 1) {
			const local = tryLocalSymbolDefinition(document, position, parts[0]);
			if (local) return local;
		}

		if (parts.length === 2 && SIS_MODULE_PREFIX_TO_DIR[parts[0]]) {
			const envHit = await tryResolveSisEnvMemberDefinition(parts[0], parts[1], undefined, token);
			if (envHit) return envHit;
		}

		if (parts.length === 3 && SIS_MODULE_PREFIX_TO_DIR[parts[0]]) {
			const envHit = await tryResolveSisEnvMemberDefinition(parts[0], parts[1], parts[2], token);
			if (envHit) return envHit;
		}

		const chainRegex = luaChainToRegex(chain.text);
		const localHits = scanDocumentForDefinitions(document, chainRegex);
		if (localHits.length > 0) return localHits;

		const runtime = await tryRuntimeDefinition(chain.expressionText, token);
		if (runtime) return runtime;

		if (parts.length === 2 && SIS_MODULE_PREFIX_TO_DIR[parts[0]]) {
			const moduleHit = await tryResolveSisModuleFieldDefinition(parts[0], parts[1], token);
			if (moduleHit) return moduleHit;
		}

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
