import * as vscode from 'vscode';
import * as path from 'node:path';
import Server from './lib/Server';
import Logger from './utils/Logger';
import StatusBarItem from './lib/StatusBarItem';
import { SisLuaSyntaxServer, isSisWorkspace } from './lib/SisLuaSyntaxServer';
import { registerLuaDefinitionProvider } from './features/LuaDefinitionProvider';
import { registerLuaFormattingProvider } from './features/LuaFormattingProvider';

const L = Logger.getLogger('extension');

var server : Server | undefined;
var changeConfigurationDisposable : vscode.Disposable | undefined;
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
  // Stay dormant outside SiS-shaped workspaces. The OpenHint TCP server
  // and the `sis_headless -lsp` client are both meaningless without the
  // SiS resource tree, and the OpenHint server in particular used to
  // bind-fail on a 10s retry loop in unrelated workspaces.
  if (!isSisWorkspace()) {
    L.info('No SiS-shaped workspace detected; staying dormant.');
    void vscode.window.showInformationMessage(
      'Stars in Shadow Dev: this does not appear to be a Stars in Shadow development environment. Extension features will stay idle in this window.',
    );
    // Still register the debug adapter factory: it is pull-based (only
    // spawns when the user explicitly launches a `lua` debug config),
    // so leaving it wired keeps "Run and Debug" working if this folder
    // happens to ship a hand-written launch config that points at an
    // out-of-tree binary. Everything else stays unwired.
    context.subscriptions.push(
      vscode.debug.registerDebugAdapterDescriptorFactory('lua', new LuaDebugAdapterDescriptorFactory(context)),
    );
    return;
  }

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
  // Either of these may be undefined if `activate()` short-circuited
  // because the workspace wasn't SiS-shaped.
  if (server) stopServer();
  if (changeConfigurationDisposable) changeConfigurationDisposable.dispose();
}
