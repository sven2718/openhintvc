import {EventEmitter} from 'events';
import * as vscode from 'vscode';
import * as net from 'net';
import Logger from '../utils/Logger';
import Command from './Command';
import RemoteFile from './RemoteFile';

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

      case 'list':
        this.handleList(command);
        this.emit('list');
        break;

      case 'connect':
        this.handleConnect(command);
        this.emit('connect');
        break;
    }
  }

  handleOpen(command : Command) {
    var fullpath = command.getVariable('real-path');
    var file = command.getVariable('display-name');
    L.trace('handleOpen',file,fullpath);
    vscode.workspace.openTextDocument(fullpath).then((textDocument : vscode.TextDocument) => {
      if (!textDocument && this.attempts < 3) {
        L.warn("Failed to open the text document, will try again");

        setTimeout(() => {
          this.attempts++;
          this.handleOpen(command);
        }, 100);
        return;

      } else if (!textDocument) {
        L.error("Could NOT open the file", file);
        vscode.window.showErrorMessage(`Failed to open file ${fullpath}`);
        return;
      }
    });
  }


  openInEditor() {
    L.trace('openInEditor');
/*
    vscode.workspace.openTextDocument(this.remoteFile.getLocalFilePath()).then((textDocument : vscode.TextDocument) => {
      if (!textDocument && this.attempts < 3) {
        L.warn("Failed to open the text document, will try again");

        setTimeout(() => {
          this.attempts++;
          this.openInEditor();
        }, 100);
        return;

      } else if (!textDocument) {
        L.error("Could NOT open the file", this.remoteFile.getLocalFilePath());
        vscode.window.showErrorMessage(`Failed to open file ${this.remoteFile.getRemoteBaseName()}`);
        return;
      }

      vscode.window.showTextDocument(textDocument).then((textEditor : vscode.TextEditor) => {
        this.handleChanges(textDocument);
        L.info(`Opening ${this.remoteFile.getRemoteBaseName()} from ${this.remoteFile.getHost()}`);
        vscode.window.setStatusBarMessage(`Opening ${this.remoteFile.getRemoteBaseName()} from ${this.remoteFile.getHost()}`, 2000);

        this.showSelectedLine(textEditor);
      });
    });
    */
  }

  handleChanges(textDocument : vscode.TextDocument) {
    L.trace('handleChanges', textDocument.fileName);

    this.subscriptions.push(vscode.workspace.onDidSaveTextDocument((savedTextDocument : vscode.TextDocument) => {
      if (savedTextDocument == textDocument) {
        this.save();
      }
    }));

    this.subscriptions.push(vscode.workspace.onDidCloseTextDocument((closedTextDocument : vscode.TextDocument) => {
      if (closedTextDocument === textDocument) {
        this.closeTimeout  && clearTimeout(this.closeTimeout);
        // If you change the textDocument language, it will close and re-open the same textDocument, so we add
        // a timeout to make sure it is really being closed before close the socket.
        this.closeTimeout = setTimeout(() => {
          this.close();
        }, 2);
      }
    }));

    this.subscriptions.push(vscode.workspace.onDidOpenTextDocument((openedTextDocument : vscode.TextDocument) => {
      if (openedTextDocument === textDocument) {
        this.closeTimeout  && clearTimeout(this.closeTimeout);
      }
    }));
  }

  showSelectedLine(textEditor : vscode.TextEditor) {
    var selection = +(this.command.getVariable('selection'));
    if (selection) {
      textEditor.revealRange(new vscode.Range(selection, 0, selection + 1, 1));
    }
  }


  handleConnect(command : Command) {
    L.trace('handleConnect', command.getName());
  }

  handleList(command : Command) {
    L.trace('handleList', command.getName());
  }

  send(cmd : string) {
    L.trace('send', cmd);

    if (this.isOnline()) {
      this.socket.write(cmd + "\n");
    }
  }

  open(filePath : string) {
    L.trace('filePath', filePath);

    this.send("open");
    this.send(`path: ${filePath}`);
    this.send("");
  }

  list(dirPath : string) {
    L.trace('list', dirPath);

    this.send("list");
    this.send(`path: ${dirPath}`);
    this.send("");
  }

  save() {
    L.trace('save');

  }

  close() {
    L.trace('close');

    if (this.isOnline()) {
      this.online = false;
      this.send("close");
      this.send("");
      this.socket.end();
    }

    this.subscriptions.forEach((disposable : vscode.Disposable) => disposable.dispose());
  }

  isOnline() {
    L.trace('isOnline');

    L.debug('isOnline?', this.online);
    return this.online;
  }
}

export default Session;
