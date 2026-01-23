import * as vscode from 'vscode';

type FormatterMode = 'whitespace' | 'simple';

const INDENT_SIZE = 2;

type LongBracketKind = 'string' | 'comment';
type LongBracketState = { kind: LongBracketKind; equals: number };

function getFormatterMode(): FormatterMode {
	const config = vscode.workspace.getConfiguration('sisDev');
	const mode = config.get<string>('luaFormatter.mode', 'whitespace');
	return mode === 'simple' ? 'simple' : 'whitespace';
}

function isIdentifierStart(ch: string): boolean {
	return /[A-Za-z_]/.test(ch);
}

function isIdentifierChar(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch);
}

function tryReadLongBracketOpen(line: string, index: number): { equals: number; endIndex: number } | undefined {
	if (line[index] !== '[') return undefined;
	let i = index + 1;
	while (i < line.length && line[i] === '=') i++;
	if (i < line.length && line[i] === '[') {
		return { equals: i - (index + 1), endIndex: i + 1 };
	}
	return undefined;
}

function tryReadLongBracketClose(line: string, index: number, equals: number): number | undefined {
	if (line[index] !== ']') return undefined;
	let i = index + 1;
	for (let j = 0; j < equals; j++) {
		if (i >= line.length || line[i] !== '=') return undefined;
		i++;
	}
	if (i >= line.length || line[i] !== ']') return undefined;
	return i + 1;
}

function findLongBracketClose(line: string, fromIndex: number, equals: number): number | undefined {
	let idx = line.indexOf(']', fromIndex);
	while (idx >= 0) {
		const endIndex = tryReadLongBracketClose(line, idx, equals);
		if (typeof endIndex === 'number') return endIndex;
		idx = line.indexOf(']', idx + 1);
	}
	return undefined;
}

function computePreDedent(line: string, startState: LongBracketState | null): number {
	if (startState) return 0;

	let i = 0;
	while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
	if (i >= line.length) return 0;

	// If it's a comment line, don't treat anything as a closer.
	if (line[i] === '-' && line[i + 1] === '-') return 0;

	// Curly brace closers at start of line: `}`, `},`, `}}`, etc.
	if (line[i] === '}') {
		let count = 0;
		while (i + count < line.length && line[i + count] === '}') count++;
		return count;
	}

	if (isIdentifierStart(line[i])) {
		const start = i;
		i++;
		while (i < line.length && isIdentifierChar(line[i])) i++;
		const word = line.slice(start, i);
		if (word === 'end' || word === 'until' || word === 'else' || word === 'elseif') return 1;
	}

	return 0;
}

function analyzeIndentDelta(line: string, startState: LongBracketState | null): { endState: LongBracketState | null; delta: number } {
	let state: LongBracketState | null = startState;
	let delta = 0;
	let inQuote: '\'' | '"' | null = null;
	let sawSignificant = false;
	let firstWordToken: string | undefined;

	let i = 0;
	while (i < line.length) {
		if (state) {
			const closeEnd = findLongBracketClose(line, i, state.equals);
			if (typeof closeEnd !== 'number') return { endState: state, delta };
			i = closeEnd;
			state = null;
			continue;
		}

		const ch = line[i];

		if (!sawSignificant && (ch === ' ' || ch === '\t')) {
			i++;
			continue;
		}
		if (!sawSignificant) sawSignificant = true;

		if (inQuote) {
			if (ch === '\\') {
				i = Math.min(i + 2, line.length);
				continue;
			}
			if (ch === inQuote) {
				inQuote = null;
				i++;
				continue;
			}
			i++;
			continue;
		}

		if (ch === '\'' || ch === '"') {
			inQuote = ch;
			i++;
			continue;
		}

		if (ch === '-' && line[i + 1] === '-') {
			const open = tryReadLongBracketOpen(line, i + 2);
			if (open) {
				state = { kind: 'comment', equals: open.equals };
				i = open.endIndex;
				continue;
			}
			break; // rest of line is a short comment
		}

		if (ch === '[') {
			const open = tryReadLongBracketOpen(line, i);
			if (open) {
				state = { kind: 'string', equals: open.equals };
				i = open.endIndex;
				continue;
			}
		}

		if (ch === '{') {
			delta++;
			i++;
			continue;
		}
		if (ch === '}') {
			delta--;
			i++;
			continue;
		}

		if (isIdentifierStart(ch)) {
			const start = i;
			i++;
			while (i < line.length && isIdentifierChar(line[i])) i++;
			const word = line.slice(start, i);
			firstWordToken = firstWordToken ?? word;

			if (word === 'end' || word === 'until') {
				delta--;
			} else if (word === 'repeat' || word === 'function' || word === 'if' || word === 'for' || word === 'while') {
				delta++;
			} else if (word === 'do') {
				// The dialect may omit `then`/`do` in some contexts; only treat `do` as an opener when it's a standalone block.
				if (firstWordToken === 'do') delta++;
			} else if (word === 'else' || word === 'elseif') {
				// net 0: closer + opener
			}
			continue;
		}

		i++;
	}

	return { endState: state, delta };
}

function normalizeLeadingWhitespace(line: string): string {
	let i = 0;
	let prefix = '';
	while (i < line.length) {
		const ch = line[i];
		if (ch === ' ') {
			prefix += ' ';
			i++;
			continue;
		}
		if (ch === '\t') {
			prefix += ' '.repeat(INDENT_SIZE);
			i++;
			continue;
		}
		break;
	}
	return prefix + line.slice(i);
}

function indentColumns(line: string): number {
	let cols = 0;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === ' ') {
			cols++;
			continue;
		}
		if (ch === '\t') {
			cols += INDENT_SIZE;
			continue;
		}
		break;
	}
	return cols;
}

function lineHasPipeFunctionOpener(line: string, startState: LongBracketState | null): boolean {
	let state: LongBracketState | null = startState;
	let inQuote: '\'' | '"' | null = null;

	let i = 0;
	while (i < line.length) {
		if (state) {
			const closeEnd = findLongBracketClose(line, i, state.equals);
			if (typeof closeEnd !== 'number') return false;
			i = closeEnd;
			state = null;
			continue;
		}

		const ch = line[i];

		if (inQuote) {
			if (ch === '\\') {
				i = Math.min(i + 2, line.length);
				continue;
			}
			if (ch === inQuote) {
				inQuote = null;
				i++;
				continue;
			}
			i++;
			continue;
		}

		if (ch === '\'' || ch === '"') {
			inQuote = ch;
			i++;
			continue;
		}

		if (ch === '-' && line[i + 1] === '-') {
			const open = tryReadLongBracketOpen(line, i + 2);
			if (open) {
				state = { kind: 'comment', equals: open.equals };
				i = open.endIndex;
				continue;
			}
			break;
		}

		if (ch === '[') {
			const open = tryReadLongBracketOpen(line, i);
			if (open) {
				state = { kind: 'string', equals: open.equals };
				i = open.endIndex;
				continue;
			}
		}

		if (ch === '|') {
			let j = i + 1;
			while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
			if (!line.startsWith('function', j)) {
				i++;
				continue;
			}
			const after = j + 'function'.length;
			const afterCh = after < line.length ? line[after] : '';
			if (afterCh === '' || !isIdentifierChar(afterCh)) return true;
		}

		i++;
	}

	return false;
}

function formatLuaLines(lines: string[], mode: FormatterMode): string[] {
	let indentLevel = 0;
	let state: LongBracketState | null = null;
	const visualIndentSuppressStack: Array<{ closeAtIndentLevel: number }> = [];

	const out: string[] = [];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const startState = state;
		const trimmed = line.trim();

		const preDedent = computePreDedent(line, startState);
		const analysis = analyzeIndentDelta(line, startState);
		const suppressionDepth = visualIndentSuppressStack.length;

		let outLine = line;

		if (!startState) {
			if (trimmed.length === 0) {
				// Preserve whitespace-only lines to avoid noisy diffs; only normalize tabs.
				outLine = line.replace(/\t/g, ' '.repeat(INDENT_SIZE));
			} else if (mode === 'simple') {
				const content = line.replace(/^[ \t]+/, '');
				const visualIndent = Math.max(0, indentLevel - preDedent - suppressionDepth);
				outLine = ' '.repeat(visualIndent * INDENT_SIZE) + content;
			} else {
				outLine = normalizeLeadingWhitespace(line);
			}
		}

		out.push(outLine);

		if (mode === 'simple' && !startState) {
			// SiS style is often "visually shallow" inside nested piped functions (esp. UI_File).
			// Respect the file's existing choice by suppressing one indent level when the block body
			// is not indented relative to the opener.
			if (lineHasPipeFunctionOpener(line, startState)) {
				const openIndent = indentColumns(line);

				let nextIndex = lineIndex + 1;
				while (nextIndex < lines.length) {
					const candidate = lines[nextIndex];
					const candidateTrimmed = candidate.trim();
					if (candidateTrimmed.length === 0) {
						nextIndex++;
						continue;
					}
					if (candidateTrimmed.startsWith('--')) {
						nextIndex++;
						continue;
					}

					const nextIndent = indentColumns(candidate);
					if (nextIndent <= openIndent) {
						visualIndentSuppressStack.push({ closeAtIndentLevel: indentLevel });
					}
					break;
				}
			}
		}

		indentLevel = Math.max(0, indentLevel + analysis.delta);
		state = analysis.endState;

		while (visualIndentSuppressStack.length > 0) {
			const top = visualIndentSuppressStack[visualIndentSuppressStack.length - 1];
			if (indentLevel > top.closeAtIndentLevel) break;
			visualIndentSuppressStack.pop();
		}
	}

	return out;
}

class LuaFormattingProvider implements vscode.DocumentFormattingEditProvider {
	provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
		const mode = getFormatterMode();
		if (mode !== 'whitespace' && mode !== 'simple') return [];

		const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		const lines: string[] = [];
		for (let i = 0; i < document.lineCount; i++) {
			lines.push(document.lineAt(i).text);
		}

		const formatted = formatLuaLines(lines, mode).join(eol);
		const original = document.getText();
		if (formatted === original) return [];

		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(original.length));
		return [vscode.TextEdit.replace(fullRange, formatted)];
	}
}

export function registerLuaFormattingProvider(context: vscode.ExtensionContext): void {
	const provider = new LuaFormattingProvider();
	context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider({ language: 'lua' }, provider));
}
