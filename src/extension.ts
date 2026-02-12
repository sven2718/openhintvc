import * as vscode from 'vscode';
import * as path from 'node:path';
import Server from './lib/Server';
import Logger from './utils/Logger';
import StatusBarItem from './lib/StatusBarItem';
import { registerLuaDefinitionProvider } from './features/LuaDefinitionProvider';
import { registerLuaFormattingProvider } from './features/LuaFormattingProvider';
import { registerLuaDiagnosticsProvider } from './features/LuaDiagnosticsProvider';

const L = Logger.getLogger('extension');

var server : Server;
var changeConfigurationDisposable : vscode.Disposable;
var port : number;
var host : string;
var onStartup : boolean;
var dontShowPortAlreadyInUseError : boolean;
var statusBarItem : StatusBarItem;

class LuaDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const adapterPath = this.context.asAbsolutePath(path.join('out', 'debugger', 'luaDebugAdapter.js'));
    return new vscode.DebugAdapterExecutable(process.execPath, [adapterPath], {
      cwd: this.context.extensionPath,
    });
  }
}

const startServer = () => {
  L.trace('startServer');

  if (!server) {
    server = new Server();
  }

  if (!statusBarItem) {
    statusBarItem = new StatusBarItem();
  }

  server.setPort(port);
  server.setHost(host);
  server.setDontShowPortAlreadyInUseError(dontShowPortAlreadyInUseError);
  server.start(false);

  statusBarItem.setServer(server);
};

const stopServer = () => {
  L.trace('stopServer');

  if (server) {
    server.stop();
  }
};

const initialize = () => {
  L.trace('initialize');

  var configuration = getConfiguration();
  onStartup = configuration.onStartup;
  port = configuration.port;
  host = configuration.host;
  dontShowPortAlreadyInUseError = configuration.dontShowPortAlreadyInUseError;

  if (onStartup) {
    startServer();
  }
};

const getConfiguration = () => {
  L.trace('getConfiguration');
  var remoteConfig = vscode.workspace.getConfiguration('remote');

  var configuration = {
    onStartup: remoteConfig.get<boolean>('onstartup'),
    dontShowPortAlreadyInUseError: remoteConfig.get<boolean>('dontShowPortAlreadyInUseError'),
    port: remoteConfig.get<number>('port'),
    host: remoteConfig.get<string>('host')
  };

  L.debug("getConfiguration", configuration);

  return configuration;
};

const hasConfigurationChanged = (configuration) => {
  L.trace('hasConfigurationChanged');
  var hasChanged = ((configuration.port !== port) ||
                    (configuration.onStartup !== onStartup) ||
                    (configuration.host !== host) ||
                    (configuration.dontShowPortAlreadyInUseError !== dontShowPortAlreadyInUseError));

  L.debug("hasConfigurationChanged?", hasChanged);
  return hasChanged;
};

const onConfigurationChange = () => {
  L.trace('onConfigurationChange');

  var configuration = getConfiguration();

  if (hasConfigurationChanged(configuration)) {
    initialize();
  }
};

export function activate(context: vscode.ExtensionContext) {
  initialize();

	context.subscriptions.push(vscode.commands.registerCommand('extension.startServer', startServer));
  context.subscriptions.push(vscode.commands.registerCommand('extension.stopServer', stopServer));

  changeConfigurationDisposable = vscode.workspace.onDidChangeConfiguration(onConfigurationChange);

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('lua', new LuaDebugAdapterDescriptorFactory(context)),
  );

  registerLuaDefinitionProvider(context);
  registerLuaFormattingProvider(context);
  registerLuaDiagnosticsProvider(context);
}

export function deactivate() {
  stopServer();
  changeConfigurationDisposable.dispose();
}