# Stars in Shadow Dev (openhintvc)

This extension is a grab-bag of Stars in Shadow development helpers:

- Lua debugger (DAP): bundles devCAT's VSCodeLuaDebug adapter, providing debug type `lua`.
- OpenHint server: allows Stars in Shadow instances to open files/lines in VS Code from in-game UI actions.

## Debugging (Lua / SiS)

Existing launch configs like `C:\dev\Leviathan\.vscode\launch.json` should work without installing the separate devCAT extension.

Typical configs use:
- `"type": "lua"`
- `-devcat` / `-debugbridge` command line options
- `listenPort` to match your game build (for Leviathan this is `46692`)

## OpenHint

The OpenHint server starts automatically by default (see settings under `remote.*`), or via:
- `SiS Dev: Start OpenHint Server`
- `SiS Dev: Stop OpenHint Server`

## Licenses

Bundled debugger binaries and their licenses live under `vslua/`.

## Building the Lua debug adapter

Adapter sources are vendored under `vslua/src/`. To rebuild `vslua/DebugAdapter.exe` and the required DLLs:
- `npm run build:debug-adapter`
