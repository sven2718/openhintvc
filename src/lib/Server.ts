import * as net from 'net';
import Session from "./Session";
import * as vscode from 'vscode';
import Logger from '../utils/Logger';
import {EventEmitter} from 'events';

const L = Logger.getLogger('Server');

const DEFAULT_PORT = 52698;
const DEFAULT_HOST = '127.0.0.1';
const MAX_CONSECUTIVE_RETRIES = 3;
const RETRY_DELAY_MS = 10000;

class Server extends EventEmitter {
  online : boolean = false;
  server : net.Server;
  port : number;
  host : string;
  dontShowPortAlreadyInUseError : boolean = false;
  defaultSession : Session;
  // Counts consecutive listen failures. Reset to 0 on success so a
  // transient hiccup doesn't accumulate toward a permanent give-up.
  private consecutiveFailures = 0;

  constructor() {
    super();
    L.trace('constructor');
  }

  start(quiet : boolean) {
    L.trace('start', quiet);

    if (!quiet) {
      // Manual restart: give the retry budget a fresh start.
      this.consecutiveFailures = 0;
    }

    if (this.isOnline()) {
      this.stop();
      L.info("Restarting server");
      vscode.window.setStatusBarMessage("Restarting server", 2000);
      this.emit('restarting');

    } else {
      if (!quiet) {
        L.info("Starting server");
        vscode.window.setStatusBarMessage("Starting server", 2000);
      }

      this.emit('starting');
    }

    this.server = net.createServer(this.onServerConnection.bind(this));

    this.server.on('listening', this.onServerListening.bind(this));
    this.server.on('error', this.onServerError.bind(this));
    this.server.on("close", this.onServerClose.bind(this));

    this.server.listen(this.getPort(), this.getHost());
  }

  setPort(port : number) {
    L.trace('setPort', port);
    this.port = port;
  }

  getPort() : number {
    L.trace('getPort', +(this.port || DEFAULT_PORT));
    return +(this.port || DEFAULT_PORT);
  }

  setHost(host : string) {
    L.trace('setHost', host);
    this.host = host;
  }

  getHost() : string {
    L.trace('getHost', (this.host || DEFAULT_HOST));
    return (this.host || DEFAULT_HOST);
  }

  setDontShowPortAlreadyInUseError(dontShowPortAlreadyInUseError : boolean) {
    L.trace('setDontShowPortAlreadyInUseError', dontShowPortAlreadyInUseError);
    this.dontShowPortAlreadyInUseError = dontShowPortAlreadyInUseError;
  }

  onServerConnection(socket) {
    L.trace('onServerConnection');

    var session = new Session(socket);
    session.send("VSCode " + 1);

    session.on('connect', () => {
      console.log("connect");
      this.defaultSession = session;
    });
  }

  onServerListening(e) {
    L.trace('onServerListening');
    this.consecutiveFailures = 0;
    this.setOnline(true);
    this.emit('ready');
  }

  onServerError(e) {
    L.trace('onServerError', e);
    L.warn(`Server error on ${this.getHost()}:${this.getPort()}: ${e.code || 'unknown'} - ${e.message || e}`);

    this.emit('error', e);

    if (e.code === 'EADDRINUSE') {
      if (this.dontShowPortAlreadyInUseError) {
        return;
      } else {
        // Prefer the configured port if error doesn't provide one
        return vscode.window.showErrorMessage(`Failed to start OpenHint server: port ${this.getPort()} is already in use.`);
      }
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures > MAX_CONSECUTIVE_RETRIES) {
      vscode.window.showErrorMessage(
        `OpenHint server failed to start after ${MAX_CONSECUTIVE_RETRIES} retries (last error: ${e.code || 'unknown'}). ` +
        `Check that port ${this.getPort()} is not blocked by Windows excluded port ranges or a firewall. ` +
        `Use "SiS Dev: Start OpenHint Server" to retry manually.`
      );
      return;
    }

    vscode.window.showErrorMessage(
      `Failed to start OpenHint server (${e.code || 'unknown'}), will try again in ${RETRY_DELAY_MS / 1000}s (attempt ${this.consecutiveFailures}/${MAX_CONSECUTIVE_RETRIES}).`
    );

    setTimeout(() => {
      this.start(true);
    }, RETRY_DELAY_MS);
  }

  onServerClose() {
    L.trace('onServerClose');
  }

  stop() {
    L.trace('stop');

    this.emit('stopped');

    if (this.isOnline()) {
      vscode.window.setStatusBarMessage("Stopping server", 2000);
      this.server.close();
      this.setOnline(false);
    }
  }

  setOnline(online : boolean) {
    L.trace('setOnline', online);
    this.online = online;
  }

  isOnline() : boolean {
    L.trace('isOnline');

    L.debug('isOnline?', this.online);
    return this.online;
  }
}

export default Server;
