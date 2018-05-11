import {EventEmitter} from 'events';
import * as vscode from 'vscode';
import * as net from 'net';
import Logger from '../utils/Logger';
import Command from './Command';

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
    var fullpath = command.getVariable('real-path');
    var file = command.getVariable('display-name');
    var line = Number(command.getVariable('line'));

    L.trace('handleOpen',file,fullpath,line);

    vscode.workspace.findFiles('*\\'+file).then((uri : vscode.Uri[]) => {
    
      //L.trace('got uris',uri);
      if(!uri[0]) {
        L.trace('using root file',vscode.workspace.rootPath, file);
        uri[0]=vscode.Uri.file(vscode.workspace.rootPath + '\\' + file);
      }

      vscode.workspace.openTextDocument(uri[0]).then((textDocument : vscode.TextDocument) => {
        //L.trace('then...');
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
  
        vscode.window.showTextDocument(textDocument,{preview: false}).then((textEditor : vscode.TextEditor) => {
         
          L.trace('showing something');
  
          textEditor.selections=[new vscode.Selection(line-1,0,line-1,0)];
          L.trace('set to',line);
          textEditor.revealRange(new vscode.Range(line-1, 0, line, 1),vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  
        });
  
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
