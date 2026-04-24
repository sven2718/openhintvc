import * as vscode from 'vscode';
import * as path from 'node:path';
import Server from './lib/Server';
import Logger from './utils/Logger';
import StatusBarItem from './lib/StatusBarItem';
import { SisLuaSyntaxServer } from './lib/SisLuaSyntaxServer';
import { registerLuaDefinitionProvider } from './features/LuaDefinitionProvider';
import { registerLuaFormattingProvider } from './features/LuaFormattingProvider';

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

function isSyntaxDiagnosticsEnabled(): boolean {
  return vscode.workspace.getConfiguration('sisDev').get<boolean>('luaSyntaxDiagnostics.enabled', true);
}

export function activate(context: vscode.ExtensionContext) {
  initialize();

	context.subscriptions.push(vscode.commands.registerCommand('extension.startServer', startServer));
  context.subscriptions.push(vscode.commands.registerCommand('extension.stopServer', stopServer));

  changeConfigurationDisposable = vscode.workspace.onDidChangeConfiguration(onConfigurationChange);

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('lua', new LuaDebugAdapterDescriptorFactory(context)),
  );

  // The SiS Lua LSP client. Diagnostics flow through it automatically
  // once started (LanguageClient's own DiagnosticCollection, populated
  // via `textDocument/publishDiagnostics`). The one non-standard thing
  // the extension still reaches for is `tokenize()`, which the Definition
  // provider calls opportunistically; see SisLuaSyntaxServer for details.
  const sisLuaSyntaxServer = new SisLuaSyntaxServer(context);
  context.subscriptions.push(sisLuaSyntaxServer);

  if (isSyntaxDiagnosticsEnabled()) {
    // Fire-and-forget: spawning `sis_headless -lsp` can take ~1s cold,
    // and activation shouldn't block the editor on it.
    void sisLuaSyntaxServer.start();
  }

  // React to user toggles of the diagnostics settings without requiring
  // a full window reload. The two settings we watch are:
  //   - `sisDev.luaSyntaxDiagnostics.enabled`
  //   - `sisDev.luaSyntaxDiagnostics.sisHeadlessPath`
  // A path change while the server is running triggers a graceful
  // restart so the new binary gets picked up.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      const enabledChanged = event.affectsConfiguration('sisDev.luaSyntaxDiagnostics.enabled');
      const pathChanged = event.affectsConfiguration('sisDev.luaSyntaxDiagnostics.sisHeadlessPath');
      if (!enabledChanged && !pathChanged) return;

      if (!isSyntaxDiagnosticsEnabled()) {
        void sisLuaSyntaxServer.stop();
        return;
      }

      if (sisLuaSyntaxServer.isRunning()) {
        void sisLuaSyntaxServer.restart();
      } else {
        void sisLuaSyntaxServer.start();
      }
    }),
  );

  registerLuaDefinitionProvider(context, sisLuaSyntaxServer);
  registerLuaFormattingProvider(context);
}

export function deactivate() {
  stopServer();
  changeConfigurationDisposable.dispose();
}
