import {EventEmitter} from 'events';
import * as vscode from 'vscode';
import * as net from 'net';
import Logger from '../utils/Logger';
import Command from './Command';
import * as path from 'path';

const L = Logger.getLogger('Session');

class Session extends EventEmitter {
  command : Command;
  socket : net.Socket;
  online : boolean;
  ready: boolean;
  subscriptions : Array<vscode.Disposable> = [];
  attempts : number = 0;
  closeTimeout : NodeJS.Timer;

  constructor(socket : net.Socket) {
    super();
    L.trace('constructor');

    this.socket = socket;
    this.online = true;

    this.socket.on('data', this.onSocketData.bind(this));
    this.socket.on('close', this.onSocketClose.bind(this));
  }

  onSocketData(chunk : Buffer) {
    L.trace('onSocketData', chunk);

    if (chunk) {
      this.parseChunk(chunk);
    }
  }

  onSocketClose() {
    L.trace('onSocketClose');
    this.online = false;
  }

  parseChunk(buffer : any) {
    L.trace('parseChunk', buffer);

    if (this.command && this.ready) {
      return;
    }

    var chunk = buffer.toString("utf8");
    var lines = chunk.split("\n");

    if (!this.command) {
      this.command = new Command(lines.shift());
    }

    while (lines.length) {
      var line = lines.shift().trim();

      if (!line) {
        break;
      }
      if(line==='.') {
        this.ready=true; 
        this.handleCommand(this.command);
        return;
      }


      var s = line.split(':');
      var name = s.shift().trim();
      var value = s.join(":").trim();

      this.command.addVariable(name, value);

    }
 
  }

  handleCommand(command : Command) {
    L.trace('handleCommand', command.getName());

    switch (command.getName()) {
      case 'open':
        this.handleOpen(command);
        break;
    }
  }

  handleOpen(command : Command) {
    const fullpath = command.getVariable('real-path');
    const file = command.getVariable('display-name');
    const line = Number(command.getVariable('line'));

    L.trace('handleOpen', file, fullpath, line);

    const openAtLine = (textDocument: vscode.TextDocument) => {
      vscode.window.showTextDocument(textDocument, { preview: false }).then((textEditor: vscode.TextEditor) => {
        L.trace('showing something');
        const targetLine = Math.max(0, line - 1);
        textEditor.selections = [new vscode.Selection(targetLine, 0, targetLine, 0)];
        L.trace('set to', targetLine + 1);
        textEditor.revealRange(new vscode.Range(targetLine, 0, targetLine + 1, 1), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      });
    };

    // 1) Try opening by real full file path first
    if (fullpath) {
      const fullUri = vscode.Uri.file(fullpath);
      vscode.workspace.openTextDocument(fullUri).then(openAtLine, (_err) => {
        // 2) Fallback: search by file name anywhere in the workspace
        this.openByNameFallback(file, fullpath, openAtLine);
      });
      return;
    }

    // No real path provided; fall back to name search
    this.openByNameFallback(file, fullpath, openAtLine);
  }

  private openByNameFallback(file: string, fullpath: string, onOpen: (doc: vscode.TextDocument) => void) {
    const glob = `**/${file}`;
    vscode.workspace.findFiles(glob, '**/node_modules/**', 10).then((uris: vscode.Uri[]) => {
      let target: vscode.Uri | undefined = uris && uris[0];

      if (!target) {
        // 3) Fallback: use first workspace folder if available
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length) {
          try {
            const joined = path.join(folders[0].uri.fsPath, file);
            target = vscode.Uri.file(joined);
          } catch (e) {
            // ignore join errors, will surface below
          }
        }
      }

      if (!target) {
        L.error('Could NOT determine file to open', file);
        vscode.window.showErrorMessage(`Failed to open file ${fullpath || file}`);
        return;
      }

      vscode.workspace.openTextDocument(target).then((textDocument: vscode.TextDocument) => {
        if (!textDocument && this.attempts < 3) {
          L.warn('Failed to open the text document, will try again');
          setTimeout(() => {
            this.attempts++;
            this.openByNameFallback(file, fullpath, onOpen);
          }, 100);
          return;
        } else if (!textDocument) {
          L.error('Could NOT open the file', file);
          vscode.window.showErrorMessage(`Failed to open file ${fullpath || file}`);
          return;
        }
        onOpen(textDocument);
      }, (_err) => {
        vscode.window.showErrorMessage(`Failed to open file ${fullpath || file}`);
      });
    });
  }

  send(cmd : string) {
    L.trace('send', cmd);

    if (this.isOnline()) {
      this.socket.write(cmd + "\n");
    }
  }

  isOnline() {
    L.trace('isOnline');

    L.debug('isOnline?', this.online);
    return this.online;
  }
}

export default Session;
