import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { DebugSession, Event, InitializedEvent, OutputEvent, Response, TerminatedEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

type LaunchOrAttachResponse = DebugProtocol.LaunchResponse | DebugProtocol.AttachResponse;

function splitCommandLine(commandLine: string): string[] {
	const args: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < commandLine.length; i++) {
		const ch = commandLine[i];
		if (ch === '"') {
			if (inQuotes && i + 1 < commandLine.length && commandLine[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
			continue;
		}

		if (!inQuotes && /\s/.test(ch)) {
			if (current.length > 0) {
				args.push(current);
				current = '';
			}
			continue;
		}

		current += ch;
	}

	if (current.length > 0) {
		args.push(current);
	}

	return args;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function asStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value) && value.every((x) => typeof x === 'string')) {
		return value;
	}
	return undefined;
}

function asEnvMap(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (v === undefined) {
			continue;
		}
		if (typeof v === 'string') {
			out[k] = v;
			continue;
		}
		if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
			out[k] = String(v);
			continue;
		}
		if (v === null) {
			out[k] = '';
			continue;
		}
		try {
			out[k] = JSON.stringify(v);
		} catch {
			out[k] = '';
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function resolveExecutable(runtimeExecutable: string, cwd: string): string | undefined {
	const candidates: string[] = [];

	if (path.isAbsolute(runtimeExecutable)) {
		candidates.push(runtimeExecutable);
	} else {
		candidates.push(path.resolve(cwd, runtimeExecutable));
		candidates.push(runtimeExecutable);
	}

	// Best-effort PATH lookup (Windows + POSIX).
	const pathVar = process.env.PATH ?? '';
	const pathExtVar = process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
	const pathExts =
		process.platform === 'win32'
			? pathExtVar.split(';').filter((x) => x.length > 0)
			: [''];
	const pathDirs = pathVar.split(path.delimiter).filter((x) => x.length > 0);

	for (const dir of pathDirs) {
		for (const ext of pathExts) {
			candidates.push(path.join(dir, runtimeExecutable + ext));
		}
	}

	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		} catch {
			// ignore
		}
	}

	return undefined;
}

class DebuggeeConnection {
	readonly socket: net.Socket;
	private buffer: Buffer = Buffer.alloc(0);
	private readonly onJsonMessage: (jsonText: string) => void;
	private readonly onSocketClosed: () => void;

	constructor(socket: net.Socket, onJsonMessage: (jsonText: string) => void, onSocketClosed: () => void) {
		this.socket = socket;
		this.onJsonMessage = onJsonMessage;
		this.onSocketClosed = onSocketClosed;

		this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
		this.socket.on('close', () => this.onSocketClosed());
		this.socket.on('error', () => this.onSocketClosed());
	}

	sendRawJsonText(jsonText: string): void {
		const bodyBytes = Buffer.from(jsonText, 'utf8');
		const headerBytes = Buffer.from(`#${bodyBytes.length}\n`, 'utf8');
		this.socket.write(headerBytes);
		this.socket.write(bodyBytes);
	}

	sendJsonMessage(msg: unknown): void {
		this.sendRawJsonText(JSON.stringify(msg));
	}

	close(): void {
		try {
			this.socket.destroy();
		} catch {
			// ignore
		}
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);

		while (true) {
			const nl = this.buffer.indexOf(0x0a /* \n */);
			if (nl < 0) return;

			const header = this.buffer.subarray(0, nl).toString('ascii');
			if (!header.startsWith('#')) {
				this.onSocketClosed();
				return;
			}

			const bodySize = Number.parseInt(header.slice(1), 10);
			if (!Number.isFinite(bodySize) || bodySize < 0) {
				this.onSocketClosed();
				return;
			}

			const bodyStart = nl + 1;
			const bodyEnd = bodyStart + bodySize;
			if (this.buffer.length < bodyEnd) return;

			const bodyBytes = this.buffer.subarray(bodyStart, bodyEnd);
			this.buffer = this.buffer.subarray(bodyEnd);

			this.onJsonMessage(bodyBytes.toString('utf8'));
		}
	}
}

class SisLuaDebugAdapterSession extends DebugSession {
	private debuggee?: DebuggeeConnection;
	private listener?: net.Server;
	private pendingStartResponse?: LaunchOrAttachResponse;
	private pendingStartRequest?: DebugProtocol.Request;

	private workingDirectory = '';
	private sourceBasePath = '';
	private listenHost = '127.0.0.1';
	private listenPort = 0;

	private launchedChild?: child_process.ChildProcess;
	private launchedExecutableFullPath?: string;
	private launchedTerminalKind?: 'integrated' | 'external';
	private launchedProcessId?: number;
	private launchedShellProcessId?: number;
	private clientSupportsRunInTerminalRequest = false;

	public constructor() {
		super();
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.clientSupportsRunInTerminalRequest = Boolean(args.supportsRunInTerminalRequest);
		response.body = response.body || {};
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsFunctionBreakpoints = false;
		response.body.supportsConditionalBreakpoints = false;
		response.body.supportsEvaluateForHovers = false;
		response.body.supportsTerminateRequest = true;
		response.body.exceptionBreakpointFilters = [];
		this.sendResponse(response);
	}

	protected dispatchRequest(request: DebugProtocol.Request): void {
		switch (request.command) {
			case 'initialize':
			case 'launch':
			case 'attach':
			case 'disconnect':
			case 'terminate':
				super.dispatchRequest(request);
				return;

			default:
				this.forwardRequestToDebuggee(request);
				return;
		}
	}

	protected launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: DebugProtocol.LaunchRequestArguments,
		request?: DebugProtocol.Request,
	): void {
		void this.startDebuggingSession('launch', response, request, args);
	}

	protected attachRequest(
		response: DebugProtocol.AttachResponse,
		args: DebugProtocol.AttachRequestArguments,
		request?: DebugProtocol.Request,
	): void {
		void this.startDebuggingSession('attach', response, request, args);
	}

	protected disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
		_args: DebugProtocol.DisconnectArguments,
		_request?: DebugProtocol.Request,
	): void {
		this.killLaunchedProcesses();
		this.closeListener();
		this.closeDebuggee();
		this.sendResponse(response);
		this.shutdown();
	}

	protected terminateRequest(
		response: DebugProtocol.TerminateResponse,
		_args: DebugProtocol.TerminateArguments,
		_request?: DebugProtocol.Request,
	): void {
		this.killLaunchedProcesses();
		this.sendResponse(response);
	}

	private closeDebuggee(): void {
		if (!this.debuggee) return;
		this.debuggee.close();
		this.debuggee = undefined;
	}

	private closeListener(): void {
		if (!this.listener) return;
		try {
			this.listener.close();
		} catch {
			// ignore
		}
		this.listener = undefined;
	}

	private async startDebuggingSession(
		kind: 'launch' | 'attach',
		response: LaunchOrAttachResponse,
		request: DebugProtocol.Request | undefined,
		args: DebugProtocol.LaunchRequestArguments | DebugProtocol.AttachRequestArguments,
	): Promise<void> {
		try {
			this.killLaunchedProcesses();
			this.closeListener();
			this.closeDebuggee();

			if (!this.readBasicConfiguration(args)) {
				this.sendErrorResponse(response, 3000, 'Invalid configuration');
				return;
			}

			const server = await this.openListener(kind, response, request, args);
			if (!server) {
				return;
			}

			this.pendingStartResponse = response;
			this.pendingStartRequest = request;

			if (kind === 'launch') {
				const ok = this.launchTargetProcess(response, args);
				if (!ok) {
					this.closeListener();
					return;
				}
			}

			this.sendEvent(
				new OutputEvent(
					`[devcat] waiting for debuggee at ${this.listenHost}:${this.listenPort}...\n`,
					'console',
				),
			);
		} catch (e) {
			this.sendErrorResponse(response, 3001, 'Failed to start debug session: {reason}', {
				reason: e instanceof Error ? e.message : String(e),
			});
			this.closeListener();
			this.closeDebuggee();
		}
	}

	private readBasicConfiguration(args: DebugProtocol.LaunchRequestArguments | DebugProtocol.AttachRequestArguments): boolean {
		const cfg = args as any;

		const workingDirectory = isNonEmptyString(cfg.workingDirectory) ? cfg.workingDirectory.trim() : '';
		if (!workingDirectory) {
			return false;
		}
		try {
			if (!fs.statSync(workingDirectory).isDirectory()) {
				return false;
			}
		} catch {
			return false;
		}

		this.workingDirectory = workingDirectory;
		this.sourceBasePath = isNonEmptyString(cfg.sourceBasePath) ? cfg.sourceBasePath : workingDirectory;

		const listenPublicly = Boolean(cfg.listenPublicly);
		this.listenHost = listenPublicly ? '0.0.0.0' : '127.0.0.1';

		const port = Number.parseInt(String(cfg.listenPort ?? ''), 10);
		this.listenPort = Number.isFinite(port) && port > 0 ? port : 56789;

		return true;
	}

	private openListener(
		kind: 'launch' | 'attach',
		response: LaunchOrAttachResponse,
		request: DebugProtocol.Request | undefined,
		args: DebugProtocol.LaunchRequestArguments | DebugProtocol.AttachRequestArguments,
	): Promise<net.Server | undefined> {
		return new Promise((resolve) => {
			const server = net.createServer((socket) => this.onDebuggeeSocket(socket));
			this.listener = server;

			const onError = (err: Error) => {
				server.removeListener('listening', onListening);
				this.listener = undefined;
				this.sendErrorResponse(response, 3015, 'Failed to bind TCP listener at {endpoint} ({reason}).', {
					endpoint: `${this.listenHost}:${this.listenPort}`,
					reason: err.message,
				});
				resolve(undefined);
			};

			const onListening = () => {
				server.removeListener('error', onError);
				resolve(server);
			};

			server.once('error', onError);
			server.once('listening', onListening);

			server.listen(this.listenPort, this.listenHost);
		});
	}

	private launchTargetProcess(
		response: DebugProtocol.LaunchResponse,
		args: DebugProtocol.LaunchRequestArguments,
	): boolean {
		const cfg = args as any;
		const runtimeExecutable = isNonEmptyString(cfg.executable) ? cfg.executable.trim() : '';
		if (!runtimeExecutable) {
			this.sendErrorResponse(response, 3005, "Property 'executable' is empty.");
			return false;
		}

		const fullExe = resolveExecutable(runtimeExecutable, this.workingDirectory);
		if (!fullExe) {
			this.sendErrorResponse(response, 3006, "Runtime executable '{path}' does not exist.", { path: runtimeExecutable });
			return false;
		}
		this.launchedExecutableFullPath = fullExe;

		const argList =
			asStringArray(cfg.arguments) ??
			(isNonEmptyString(cfg.arguments) ? splitCommandLine(cfg.arguments) : []);
		const env = asEnvMap(cfg.env);

		const consolePref = isNonEmptyString(cfg.console) ? cfg.console : undefined;
		if (consolePref === 'integratedTerminal' || consolePref === 'externalTerminal') {
			if (!this.clientSupportsRunInTerminalRequest) {
				this.sendErrorResponse(
					response,
					3010,
					"'console' was set to '{console}', but the client does not support the 'runInTerminal' request.",
					{ console: consolePref },
				);
				return false;
			}

			const kind = consolePref === 'integratedTerminal' ? 'integrated' : 'external';
			this.launchedTerminalKind = kind;

			this.runInTerminalRequest(
				{
					kind,
					title: 'Lua Debug Target',
					cwd: this.workingDirectory,
					args: [fullExe, ...argList],
					env,
				},
				15000,
				(runResponse) => {
					if (runResponse.success && runResponse.body) {
						this.launchedProcessId = runResponse.body.processId;
						this.launchedShellProcessId = runResponse.body.shellProcessId;
					} else {
						this.sendEvent(
							new OutputEvent(
								`[devcat] runInTerminal failed: ${runResponse.message ?? 'unknown error'}\n`,
								'stderr',
							),
						);
					}
				},
			);
			return true;
		}

		const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };
		const child = child_process.spawn(fullExe, argList, {
			cwd: this.workingDirectory,
			env: mergedEnv,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.launchedChild = child;

		child.stdout?.on('data', (chunk: Buffer) => {
			this.sendEvent(new OutputEvent(chunk.toString('utf8'), 'stdout'));
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			this.sendEvent(new OutputEvent(chunk.toString('utf8'), 'stderr'));
		});
		child.on('exit', (code) => {
			this.sendEvent(new OutputEvent(`[devcat] process exited with code ${code ?? 'unknown'}\n`, 'console'));
		});

		return true;
	}

	private onDebuggeeSocket(socket: net.Socket): void {
		if (this.debuggee) {
			socket.destroy();
			return;
		}

		socket.setNoDelay(true);
		this.closeListener();

		this.debuggee = new DebuggeeConnection(
			socket,
			(jsonText) => this.onDebuggeeJsonText(jsonText),
			() => this.onDebuggeeDisconnected(),
		);

		this.debuggee.sendJsonMessage({
			command: 'welcome',
			sourceBasePath: this.sourceBasePath,
			directorySeperator: path.sep,
		});

		if (this.pendingStartResponse) {
			this.sendResponse(this.pendingStartResponse);
			this.pendingStartResponse = undefined;
			this.pendingStartRequest = undefined;
			this.sendEvent(new InitializedEvent());
		}
	}

	private onDebuggeeJsonText(jsonText: string): void {
		let msg: any;
		try {
			msg = JSON.parse(jsonText);
		} catch {
			this.sendEvent(new OutputEvent(`[devcat] invalid JSON from debuggee: ${jsonText}\n`, 'stderr'));
			return;
		}

		if (msg?.type === 'event' && typeof msg.event === 'string') {
			this.sendEvent(new Event(msg.event, msg.body));
			return;
		}

		if (msg?.type === 'response' && typeof msg.command === 'string') {
			this.sendResponse(msg as DebugProtocol.Response);
			return;
		}

		this.sendEvent(new OutputEvent(`[devcat] unhandled debuggee message: ${jsonText}\n`, 'stderr'));
	}

	private onDebuggeeDisconnected(): void {
		this.debuggee = undefined;
		this.sendEvent(new TerminatedEvent());
		this.shutdown();
	}

	private forwardRequestToDebuggee(request: DebugProtocol.Request): void {
		if (!this.debuggee) {
			this.sendErrorResponse(
				new Response(request),
				999,
				'Debuggee not connected (waiting on {endpoint}).',
				{ endpoint: `${this.listenHost}:${this.listenPort}` },
			);
			return;
		}

		this.debuggee.sendRawJsonText(JSON.stringify(request));
	}

	private killLaunchedProcesses(): void {
		if (this.launchedChild) {
			try {
				this.launchedChild.kill();
			} catch {
				// ignore
			}
			this.launchedChild = undefined;
		}

		// Best-effort kill of VS Code spawned processes.
		//
		// For integrated terminals, avoid killing the terminal shell when VS Code reports the same pid.
		const pids = new Set<number>();
		if (typeof this.launchedProcessId === 'number') {
			const keepShellAlive =
				this.launchedTerminalKind === 'integrated' &&
				typeof this.launchedShellProcessId === 'number' &&
				this.launchedProcessId === this.launchedShellProcessId;
			if (!keepShellAlive) {
				pids.add(this.launchedProcessId);
			}
		}
		if (this.launchedTerminalKind !== 'integrated' && typeof this.launchedShellProcessId === 'number') {
			pids.add(this.launchedShellProcessId);
		}

		for (const pid of pids) {
			try {
				process.kill(pid);
			} catch {
				// ignore
			}
		}

		this.launchedProcessId = undefined;
		this.launchedShellProcessId = undefined;
		this.launchedTerminalKind = undefined;
		this.launchedExecutableFullPath = undefined;
	}
}

DebugSession.run(SisLuaDebugAdapterSession);
