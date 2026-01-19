# Stars in Shadow Dev (openhintvc)

This extension is a grab-bag of Stars in Shadow development helpers:

- Lua debugger (DAP): Node-based adapter (no Mono/.NET), providing debug type `lua`.
- OpenHint server: allows Stars in Shadow instances to open files/lines in VS Code from in-game UI actions.

## Debugging (Lua / SiS)

Existing launch configs like `C:\dev\Leviathan\.vscode\launch.json` should work once this extension is installed (no separate debugger extension required).

Typical configs use:
- `"type": "lua"`
- `-vscode` (enables the SiS Lua debugger) / `-debugbridge` command line options
- `listenPort` to match your game build (for Leviathan this is `46692`)

Provenance: the on-the-wire debuggee protocol started as a fork of devCAT's
VSCodeLuaDebug, but the adapter side is now maintained as part of the Stars in
Shadow dev tools.

## OpenHint

The OpenHint server starts automatically by default (see settings under `remote.*`), or via:
- `SiS Dev: Start OpenHint Server`
- `SiS Dev: Stop OpenHint Server`

## Licenses

The Lua debug adapter is implemented in TypeScript under `src/debugger/` (built into `out/`).

## Local build + install (no publishing)

### Option A: Run from source (recommended for development)

1. `npm install`
2. `npm run build:all`
3. In VS Code, press `F5` (launches an “Extension Development Host” via `.vscode/launch.json`).

### Option B: Build a `.vsix` and install it

1. `npm install`
2. `npm run build:all`
3. `npx @vscode/vsce package`
4. Install the resulting `openhintvc-<version>.vsix`:
   - VS Code UI: Extensions view → `...` → `Install from VSIX...`
   - CLI: `code --install-extension .\openhintvc-<version>.vsix --force`

## Publishing

Publishing requires a VS Code Marketplace publisher (this extension id is `sven2718.openhintvc`) and a Personal Access Token (PAT).

1. Bump version: `npm version patch` (or `minor` / `major`)
2. `npm ci`
3. `npm run build:all`
4. (Recommended) Smoke-test the package: `npx @vscode/vsce package`
5. Publish:
   - `npx @vscode/vsce login sven2718`
   - `npx @vscode/vsce publish`
