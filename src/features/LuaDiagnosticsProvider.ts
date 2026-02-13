import * as vscode from 'vscode';
import Logger from '../utils/Logger';
import { SisLuaSyntaxServer } from '../lib/SisLuaSyntaxServer';

const L = Logger.getLogger('LuaDiagnosticsProvider');

const VALIDATE_DEBOUNCE_MS = 250;

function getLuaSyntaxDiagnosticsEnabled(): boolean {
	const config = vscode.workspace.getConfiguration('sisDev');
	return config.get<boolean>('luaSyntaxDiagnostics.enabled', true);
}

class LuaSyntaxDiagnostics implements vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;
	private readonly server: SisLuaSyntaxServer;
	private readonly timers = new Map<string, NodeJS.Timeout>();

	constructor(server: SisLuaSyntaxServer) {
		this.collection = vscode.languages.createDiagnosticCollection('sisLuaSyntax');
		this.server = server;
	}

	dispose(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		this.collection.dispose();
	}

	clear(document: vscode.TextDocument): void {
		this.collection.delete(document.uri);
	}

	schedule(document: vscode.TextDocument): void {
		if (document.languageId !== 'lua') return;
		if (document.uri.scheme !== 'file') return;

		if (!getLuaSyntaxDiagnosticsEnabled()) {
			this.clear(document);
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

export function registerLuaDiagnosticsProvider(context: vscode.ExtensionContext, server: SisLuaSyntaxServer): void {
	const diagnostics = new LuaSyntaxDiagnostics(server);
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
