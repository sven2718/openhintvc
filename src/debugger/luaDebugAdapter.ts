import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { DebugSession, Event, InitializedEvent, OutputEvent, Response, TerminatedEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

// SiS Lua debug adapter.
//
// Adapter<->debuggee protocol provenance:
// - This speaks the existing SiS Lua debuggee protocol (TCP + `#<len>\\n<json>` framing + a `welcome` message),
//   which started as a fork of devCAT's VSCodeLuaDebug debuggee.
// - We keep compatibility with the (well-proven) in-engine Lua debuggee hooks, while the adapter side is now
//   implemented in Node/TypeScript for better cross-platform support.

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

function win32PeSubsystem(exePath: string): number | undefined {
	if (process.platform !== 'win32') {
		return undefined;
	}

	let fd: number | undefined;
	try {
		fd = fs.openSync(exePath, 'r');

		const dosHeader = Buffer.alloc(0x40);
		if (fs.readSync(fd, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
			return undefined;
		}
		const peOffset = dosHeader.readUInt32LE(0x3c);

		// PE signature (4) + COFF file header (20) + optional header through Subsystem (offset 68 + 2 bytes).
		const peHeader = Buffer.alloc(4 + 20 + 72);
		if (fs.readSync(fd, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
			return undefined;
		}
		if (peHeader.toString('ascii', 0, 4) !== 'PE\u0000\u0000') {
			return undefined;
		}

		const optionalHeaderStart = 4 + 20;
		const magic = peHeader.readUInt16LE(optionalHeaderStart);
		if (magic !== 0x10b && magic !== 0x20b) {
			return undefined;
		}

		return peHeader.readUInt16LE(optionalHeaderStart + 68);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// ignore
			}
		}
	}
}

function shouldWrapRunInTerminalWithCmd(exePath: string): boolean {
	if (process.platform !== 'win32') {
		return false;
	}
	if (path.extname(exePath).toLowerCase() !== '.exe') {
		return false;
	}

	// IMAGE_SUBSYSTEM_WINDOWS_GUI (2) vs IMAGE_SUBSYSTEM_WINDOWS_CUI (3).
	const subsystem = win32PeSubsystem(exePath);
	if (subsystem === 2) {
		return true;
	}
	if (subsystem === 3) {
		return false;
	}

	// Fallback: treat SiS GUI targets as GUI even if PE parsing fails.
	const base = path.basename(exePath).toLowerCase();
	return base === 'sis.exe' || base === 'sis64.exe';
}

function killProcessTreeBestEffort(pid: number): void {
	if (!Number.isFinite(pid) || pid <= 0) {
		return;
	}

	// On Windows, `process.kill(pid)` only terminates that process and does not
	// reliably take down GUI targets spawned via `runInTerminal` (often a shell
	// pid), leaving `sis.exe` running after Shift+F5.
	if (process.platform === 'win32') {
		try {
			const child = child_process.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
				stdio: 'ignore',
				windowsHide: true,
				detached: true,
			});
			child.unref();
			return;
		} catch {
			// fall through to `process.kill`
		}
	}

	try {
		process.kill(pid);
	} catch {
		// ignore
	}
}

function killImageTreeBestEffort(imageName: string): void {
	if (process.platform !== 'win32') {
		return;
	}
	if (!isNonEmptyString(imageName)) {
		return;
	}

	try {
		const child = child_process.spawn('taskkill', ['/IM', imageName, '/T', '/F'], {
			stdio: 'ignore',
			windowsHide: true,
			detached: true,
		});
		child.unref();
	} catch {
		// ignore
	}
}

function killProcessDescendantsBestEffort(rootPid: number): void {
	if (process.platform !== 'win32') {
		return;
	}
	if (!Number.isFinite(rootPid) || rootPid <= 0) {
		return;
	}

	// Use PowerShell to kill only descendants of the integrated terminal shell pid,
	// leaving the shell alive (avoids VS Code's noisy "terminal process ... exit code: 1" popup).
	// This is a best-effort fallback for cases where the debuggee can't process `sis_exit`
	// promptly (e.g. a long-running load step that doesn't call `debuggee.poll()`).
	const script = [
		"$ErrorActionPreference='SilentlyContinue'",
		'function Get-Descendants([int]$ppid) {',
		"\t$children = Get-CimInstance Win32_Process -Filter \"ParentProcessId=$ppid\" | Select-Object -ExpandProperty ProcessId",
		"\tforeach($c in $children) {",
		"\t\t$c",
		'\t\tGet-Descendants $c',
		'\t}',
		'}',
		'$root = [int]$args[0]',
		'$desc = @(Get-Descendants $root) | Select-Object -Unique',
		'foreach($pid in $desc) { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue }',
		'exit 0',
	].join('; ');

	try {
		const child = child_process.spawn(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, String(rootPid)],
			{ stdio: 'ignore', windowsHide: true, detached: true },
		);
		child.unref();
	} catch {
		// ignore
	}
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
	private sessionToken = 0;
	private stopping = false;
	private activeKind?: 'launch' | 'attach';
	private customRequestSeq = 1;

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
		// Hover values are most reliable via explicit `evaluate` (vs reusing cached Variables view state).
		response.body.supportsEvaluateForHovers = true;
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
		this.stopDebuggingSession(response);
	}

	protected terminateRequest(
		response: DebugProtocol.TerminateResponse,
		_args: DebugProtocol.TerminateArguments,
		_request?: DebugProtocol.Request,
	): void {
		this.stopDebuggingSession(response);
	}

	private stopDebuggingSession(response: DebugProtocol.Response): void {
		// First: unblock VS Code (always respond quickly).
		// If launch/attach is still pending (we haven't seen a debuggee connect yet),
		// respond to that request too so the client can shut down cleanly.
		if (this.pendingStartResponse) {
			// VS Code treats a failed launch response as a modal error (beep + click-to-dismiss).
			// For "Stop Debugging before the debuggee connects", we prefer a clean no-error stop.
			this.pendingStartResponse.success = true;
			delete (this.pendingStartResponse as any).message;
			this.sendResponse(this.pendingStartResponse);
			this.pendingStartResponse = undefined;
			this.pendingStartRequest = undefined;
		}

		this.sendResponse(response);

		if (this.stopping) {
			return;
		}
		this.stopping = true;
		this.sessionToken++;

		// Some stop paths send `terminate` without a follow-up `disconnect`.
		this.sendEvent(new TerminatedEvent());

		// If we launched the debuggee and it is connected, ask it to exit cleanly
		// so we don't have to kill the integrated terminal shell (which triggers
		// VS Code's "terminal process ... terminated with exit code: 1" popup).
		const stopToken = this.sessionToken;
		if (this.activeKind === 'launch' && this.debuggee) {
			this.requestDebuggeeExitBestEffort();
			setTimeout(() => {
				if (stopToken !== this.sessionToken) return;

				// If the debuggee didn't exit quickly (common during long-running loads),
				// force-kill the launched game while keeping the integrated shell alive.
				if (process.platform === 'win32') {
					if (this.launchedTerminalKind === 'integrated' && typeof this.launchedShellProcessId === 'number') {
						killProcessDescendantsBestEffort(this.launchedShellProcessId);
					} else if (this.launchedExecutableFullPath) {
						killImageTreeBestEffort(path.basename(this.launchedExecutableFullPath));
					}
				}

				this.killLaunchedProcesses();
				this.closeListener();
				this.closeDebuggee();
				this.shutdown();
			}, 250);
			return;
		}

		// Stop before connect: best-effort hard kill the launched image, but avoid
		// killing the integrated terminal shell (rare edge case).
		if (this.activeKind === 'launch' && process.platform === 'win32' && this.launchedExecutableFullPath) {
			killImageTreeBestEffort(path.basename(this.launchedExecutableFullPath));
		}

		setImmediate(() => {
			this.killLaunchedProcesses();
			this.closeListener();
			this.closeDebuggee();
			this.shutdown();
		});
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
		const startToken = ++this.sessionToken;
		this.stopping = false;
		this.activeKind = kind;
		try {
			this.killLaunchedProcesses();
			this.closeListener();
			this.closeDebuggee();

			if (!this.readBasicConfiguration(args)) {
				this.sendErrorResponse(response, 3000, 'Invalid configuration');
				return;
			}

			const server = await this.openListener(kind, response, request, args);
			if (startToken !== this.sessionToken) {
				try {
					server?.close();
				} catch {
					// ignore
				}
				return;
			}
			if (!server) {
				return;
			}

			this.pendingStartResponse = response;
			this.pendingStartRequest = request;

			if (kind === 'launch') {
				const ok = this.launchTargetProcess(response, args);
				if (startToken !== this.sessionToken) {
					return;
				}
				if (!ok) {
					this.closeListener();
					return;
				}
			}

			this.sendEvent(
				new OutputEvent(
					`[sis] waiting for debuggee at ${this.listenHost}:${this.listenPort}...\n`,
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
			// On Windows, some shells don't keep the terminal "owned" by GUI-subsystem
			// executables, which leaves the shell prompt active and makes stdin/output
			// unusable for interactive `-console` sessions. Wrap GUI exes with
			// `cmd.exe /c` so the terminal blocks until the target exits.
			const terminalArgs = kind === 'integrated' && shouldWrapRunInTerminalWithCmd(fullExe)
				? ['cmd.exe', '/c', fullExe, ...argList]
				: [fullExe, ...argList];

			this.runInTerminalRequest(
				{
					kind,
					title: 'SiS Lua Debug Target',
					cwd: this.workingDirectory,
					args: terminalArgs,
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
								`[sis] runInTerminal failed: ${runResponse.message ?? 'unknown error'}\n`,
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
			this.sendEvent(new OutputEvent(`[sis] process exited with code ${code ?? 'unknown'}\n`, 'console'));
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
			this.sendEvent(new OutputEvent(`[sis] invalid JSON from debuggee: ${jsonText}\n`, 'stderr'));
			return;
		}

		if (msg?.type === 'event' && typeof msg.event === 'string') {
			// Adapter-internal control events.
			if (msg.event === 'sis_adapter_internal' && msg?.body && typeof msg.body === 'object') {
				// Currently unused; reserved for future.
				return;
			}
			this.sendEvent(new Event(msg.event, msg.body));
			return;
		}

		if (msg?.type === 'response' && typeof msg.command === 'string') {
			this.sendResponse(msg as DebugProtocol.Response);
			return;
		}

		this.sendEvent(new OutputEvent(`[sis] unhandled debuggee message: ${jsonText}\n`, 'stderr'));
	}

	private onDebuggeeDisconnected(): void {
		this.debuggee = undefined;
		if (this.stopping) {
			this.shutdown();
			return;
		}
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
		const pids = new Set<number>();

		if (this.launchedChild) {
			if (typeof this.launchedChild.pid === 'number') {
				pids.add(this.launchedChild.pid);
			}
			try {
				this.launchedChild.kill();
			} catch {
				// ignore
			}
			this.launchedChild = undefined;
		}

		// Best-effort kill of VS Code spawned processes.
		//
		// For integrated terminals, do *not* kill the shell process (PowerShell/CMD),
		// otherwise VS Code shows a noisy "terminal process ... terminated with exit code: 1".
		// Instead, we ask the debuggee to exit cleanly (see `requestDebuggeeExitBestEffort`).
		if (this.launchedTerminalKind === 'external') {
			if (typeof this.launchedProcessId === 'number') {
				pids.add(this.launchedProcessId);
			}
			if (typeof this.launchedShellProcessId === 'number') {
				pids.add(this.launchedShellProcessId);
			}
		}

		for (const pid of pids) {
			killProcessTreeBestEffort(pid);
		}

		this.launchedProcessId = undefined;
		this.launchedShellProcessId = undefined;
		this.launchedTerminalKind = undefined;
		this.launchedExecutableFullPath = undefined;
	}

	private requestDebuggeeExitBestEffort(): void {
		if (!this.debuggee) return;
		try {
			this.debuggee.sendRawJsonText(
				JSON.stringify({
					seq: this.customRequestSeq++,
					type: 'request',
					command: 'sis_exit',
					arguments: {},
				}),
			);
		} catch {
			// ignore
		}
	}
}

DebugSession.run(SisLuaDebugAdapterSession);
