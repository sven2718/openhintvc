export type SisLuaTokenKind = 'identifier' | 'keyword' | 'punct' | 'number';

export type SisLuaToken = {
	kind: SisLuaTokenKind;
	text: string;
	offset: number;
	atLineStart: boolean;
};

const LUA_KEYWORDS = new Set([
	'and',
	'break',
	'do',
	'else',
	'elseif',
	'end',
	'false',
	'for',
	'function',
	'goto',
	'if',
	'in',
	'local',
	'nil',
	'not',
	'or',
	'repeat',
	'return',
	'then',
	'true',
	'until',
	'while',
]);

function isIdentifierStart(ch: string): boolean {
	return /[A-Za-z_]/.test(ch);
}

function isIdentifierChar(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
	return /[0-9]/.test(ch);
}

function tryReadLongBracketOpen(text: string, index: number): { equals: number; endIndex: number } | undefined {
	if (text[index] !== '[') return undefined;
	let i = index + 1;
	while (i < text.length && text[i] === '=') i++;
	if (i < text.length && text[i] === '[') {
		return { equals: i - (index + 1), endIndex: i + 1 };
	}
	return undefined;
}

function tryReadLongBracketClose(text: string, index: number, equals: number): number | undefined {
	if (text[index] !== ']') return undefined;
	let i = index + 1;
	for (let j = 0; j < equals; j++) {
		if (i >= text.length || text[i] !== '=') return undefined;
		i++;
	}
	if (i >= text.length || text[i] !== ']') return undefined;
	return i + 1;
}

function findLongBracketClose(text: string, fromIndex: number, equals: number): number | undefined {
	let idx = text.indexOf(']', fromIndex);
	while (idx >= 0) {
		const endIndex = tryReadLongBracketClose(text, idx, equals);
		if (typeof endIndex === 'number') return endIndex;
		idx = text.indexOf(']', idx + 1);
	}
	return undefined;
}

export function tokenizeSisLua(text: string, maxOffset: number = text.length): SisLuaToken[] {
	const tokens: SisLuaToken[] = [];

	let i = 0;
	let lineHasToken = false;

	const push = (kind: SisLuaTokenKind, start: number, end: number): void => {
		if (start >= maxOffset) return;
		tokens.push({
			kind,
			text: text.slice(start, end),
			offset: start,
			atLineStart: !lineHasToken,
		});
		lineHasToken = true;
	};

	const noteSkippedText = (start: number, end: number): void => {
		// If we skipped over any newlines, the next real token starts a new line.
		const nl = text.indexOf('\n', start);
		if (nl >= 0 && nl < end) lineHasToken = false;
	};

	while (i < text.length) {
		if (i >= maxOffset) break;

		const ch = text[i];

		if (ch === '\n') {
			i++;
			lineHasToken = false;
			continue;
		}

		if (ch === '\r' || ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f') {
			i++;
			continue;
		}

		// Short / long comments.
		if (ch === '-' && text[i + 1] === '-') {
			const longOpen = tryReadLongBracketOpen(text, i + 2);
			if (longOpen) {
				const close = findLongBracketClose(text, longOpen.endIndex, longOpen.equals);
				const end = typeof close === 'number' ? close : text.length;
				noteSkippedText(i, end);
				i = end;
				continue;
			}

			// Short comment: consume to newline (but leave the newline itself).
			const nl = text.indexOf('\n', i + 2);
			if (nl < 0) break;
			i = nl;
			continue;
		}

		// Long bracket strings.
		if (ch === '[') {
			const longOpen = tryReadLongBracketOpen(text, i);
			if (longOpen) {
				const close = findLongBracketClose(text, longOpen.endIndex, longOpen.equals);
				const end = typeof close === 'number' ? close : text.length;
				noteSkippedText(i, end);
				i = end;
				continue;
			}
		}

		// Short quoted strings.
		if (ch === '"' || ch === '\'') {
			const quote = ch;
			let j = i + 1;
			while (j < text.length) {
				const c = text[j];
				if (c === '\\') {
					j = Math.min(j + 2, text.length);
					continue;
				}
				if (c === quote) {
					j++;
					break;
				}
				if (c === '\n') break;
				j++;
			}
			noteSkippedText(i, j);
			i = j;
			continue;
		}

		// Numbers.
		if (isDigit(ch)) {
			const start = i;
			i++;
			while (i < text.length && (isDigit(text[i]) || text[i] === '.')) i++;
			push('number', start, i);
			continue;
		}

		// Identifiers / keywords.
		if (isIdentifierStart(ch)) {
			const start = i;
			i++;
			while (i < text.length && isIdentifierChar(text[i])) i++;
			const word = text.slice(start, i);
			push(LUA_KEYWORDS.has(word) ? 'keyword' : 'identifier', start, i);
			continue;
		}

		// Multi-character punctuators we care about.
		const three = text.slice(i, i + 3);
		if (three === '...') {
			push('punct', i, i + 3);
			i += 3;
			continue;
		}

		const two = text.slice(i, i + 2);
		if (
			two === '::' ||
			two === '==' ||
			two === '~=' ||
			two === '<=' ||
			two === '>=' ||
			two === '..' ||
			two === '++' ||
			two === '+=' ||
			two === '-=' ||
			two === '*=' ||
			two === '/=' ||
			two === '%=' ||
			two === '^='
		) {
			push('punct', i, i + 2);
			i += 2;
			continue;
		}

		// Single-character punctuator.
		push('punct', i, i + 1);
		i++;
	}

	return tokens;
}

type BlockKind = 'function' | 'if' | 'for' | 'while' | 'repeat' | 'do';
type Block = { kind: BlockKind };

export function findSisLuaLocalDefinitionOffset(text: string, cutoffOffset: number, identifier: string): number | undefined {
	const tokens = tokenizeSisLua(text, cutoffOffset);

	const scopes: Array<Map<string, number>> = [new Map()];
	const blocks: Block[] = [];

	let pendingRepeatClose = false;

	const declareLocal = (name: string, offset: number): void => {
		scopes[scopes.length - 1].set(name, offset);
	};

	const pushBlock = (kind: BlockKind): void => {
		blocks.push({ kind });
		scopes.push(new Map());
	};

	const closeTopBlock = (): void => {
		if (blocks.length === 0 || scopes.length <= 1) return;
		blocks.pop();
		scopes.pop();
	};

	const closeRepeatIfNeeded = (): void => {
		if (!pendingRepeatClose) return;
		pendingRepeatClose = false;
		if (blocks.length > 0 && blocks[blocks.length - 1].kind === 'repeat') {
			closeTopBlock();
		}
	};

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];

		if (tok.atLineStart) {
			closeRepeatIfNeeded();
		}

		if (pendingRepeatClose && tok.kind === 'punct' && tok.text === ';') {
			// Conservative: `repeat ... until <expr>; next_statement` in one line.
			closeRepeatIfNeeded();
		}

		if (tok.kind !== 'keyword') continue;

		if (tok.text === 'local') {
			const next = tokens[i + 1];
			if (next?.kind === 'keyword' && next.text === 'function') {
				const nameTok = tokens[i + 2];
				if (nameTok?.kind === 'identifier') {
					declareLocal(nameTok.text, nameTok.offset);
				}
				continue;
			}

			let j = i + 1;
			while (j < tokens.length) {
				const t = tokens[j];
				if (t.kind !== 'identifier') break;
				declareLocal(t.text, t.offset);
				j++;
				if (tokens[j]?.kind === 'punct' && tokens[j]?.text === ',') {
					j++;
					continue;
				}
				break;
			}

			continue;
		}

		if (tok.text === 'for') {
			pushBlock('for');

			let j = i + 1;
			while (j < tokens.length) {
				const t = tokens[j];
				if (t.kind !== 'identifier') break;
				declareLocal(t.text, t.offset);
				j++;
				if (tokens[j]?.kind === 'punct' && tokens[j]?.text === ',') {
					j++;
					continue;
				}
				break;
			}

			continue;
		}

		if (tok.text === 'while') {
			pushBlock('while');
			continue;
		}

		if (tok.text === 'repeat') {
			pushBlock('repeat');
			continue;
		}

		if (tok.text === 'if') {
			pushBlock('if');
			continue;
		}

		if (tok.text === 'elseif' || tok.text === 'else') {
			// Each branch has its own local scope.
			if (blocks.length > 0 && blocks[blocks.length - 1].kind === 'if' && scopes.length > 1) {
				scopes.pop();
				scopes.push(new Map());
			}
			continue;
		}

		if (tok.text === 'function') {
			// Detect `function t:m(...)` for implicit `self`.
			let isMethod = false;
			let parenIndex = -1;
			for (let j = i + 1; j < tokens.length; j++) {
				const t = tokens[j];
				if (t.kind === 'punct' && t.text === '(') {
					parenIndex = j;
					break;
				}
				if (t.kind === 'punct' && t.text === ':') isMethod = true;
				// If we hit a line start before the `(`, bail out (malformed).
				if (j > i + 1 && t.atLineStart) break;
			}

			pushBlock('function');

			if (isMethod) {
				declareLocal('self', tok.offset);
			}

			if (parenIndex >= 0) {
				for (let j = parenIndex + 1; j < tokens.length; j++) {
					const t = tokens[j];
					if (t.kind === 'punct' && t.text === ')') break;
					if (t.kind === 'identifier') {
						declareLocal(t.text, t.offset);
					}
				}
			}

			continue;
		}

		if (tok.text === 'do' && tok.atLineStart) {
			pushBlock('do');
			continue;
		}

		if (tok.text === 'end') {
			closeRepeatIfNeeded();
			closeTopBlock();
			continue;
		}

		if (tok.text === 'until') {
			// In Lua, locals declared inside `repeat ... until` are visible in the
			// `until <expr>` condition; close the scope after that line.
			if (blocks.length > 0 && blocks[blocks.length - 1].kind === 'repeat') {
				pendingRepeatClose = true;
			}
			continue;
		}
	}

	closeRepeatIfNeeded();

	for (let s = scopes.length - 1; s >= 0; s--) {
		const off = scopes[s].get(identifier);
		if (typeof off === 'number') return off;
	}

	return undefined;
}

function isAssignmentOp(token: SisLuaToken | undefined): boolean {
	return token?.kind === 'punct' && (token.text === '=' || token.text === '+=' || token.text === '-=' || token.text === '*=' || token.text === '/=' || token.text === '%=' || token.text === '^=');
}

export function findSisLuaUnqualifiedDefinitionOffsets(text: string, identifier: string): number[] {
	const tokens = tokenizeSisLua(text);
	const offsets: number[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];

		if (tok.kind === 'keyword' && tok.text === 'function') {
			const nameTok = tokens[i + 1];
			if (nameTok?.kind === 'identifier' && nameTok.text === identifier) {
				offsets.push(nameTok.offset);
			}
			continue;
		}

		if (!tok.atLineStart) continue;
		if (tok.kind !== 'identifier') continue;

		// Parse `a, b, c = ...` varlists at the start of a statement.
		let j = i;
		let foundOffset: number | undefined;

		while (j < tokens.length) {
			const nameTok = tokens[j];
			if (nameTok.kind !== 'identifier') break;
			if (nameTok.text === identifier) foundOffset = nameTok.offset;

			j++;

			const comma = tokens[j];
			if (comma?.kind === 'punct' && comma.text === ',') {
				j++;
				continue;
			}

			break;
		}

		if (isAssignmentOp(tokens[j]) && typeof foundOffset === 'number') {
			offsets.push(foundOffset);
		}
	}

	return offsets;
}
