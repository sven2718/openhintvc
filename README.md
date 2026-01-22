# Stars in Shadow Developer Extension

This extension is your one-stop shop for Stars in Shadow development utilities!  It includes:

- Lua debugger: An evolution of devcat's excellent [lua debugger](https://github.com/devcat-studio/VSCodeLuaDebug), tweaked to work better with SiS's quirky runtime enviornement.
- OpenHint server:  A tiny integrated server that allows your running copy of Stars in Shadow to open files in VS Code.

## Debugging (Lua / SiS)

The launch config provided in your `Stars in Shadow\Lua state\.vscode` folder should work once this extension is installed (no separate debugger extension is required).

Typical configs use:
- `"type": "lua"`
-  Typical command line option include: 
    -  `-vscode` (enables the SiS Lua debugger)
    - `-console` (echo game engine outputs to a seperate term)
    -  `-debugbridge` (emulate msvc debug string handling).
- `listenPort`: SiS defaults to `46692` -- you probably want to keep that default.

## Lua breakpoints

For some reason that I can't figure out, after installing this extension, you'll probably need to change your workspace settings to set `debug.allowBreakpointsEverywhere`.  (If any other lua debugger devs have any idea how to remove the need for this weird kludge, let me know).

## Code Provenance

The debuggee protocol started as a fork of devCAT's [VSCodeLuaDebug](https://github.com/devcat-studio/VSCodeLuaDebug); but I've been tweaking it as I see fit.  Props to both Seungjae Lee (@devcat) his integration work, and Dan Tull (@adobe) for his awesome `OP_HAULT` patch.  For a deeper dive into what's going on here, see this old [lua-l thread](http://lua-users.org/lists/lua-l/2018-05/msg00115.html).

## OpenHint

The OpenHint server starts automatically when vscode open (see settings under `remote.*`), but you can also control it manually via:
- `SiS Dev: Start OpenHint Server`
- `SiS Dev: Stop OpenHint Server`

# Extension Developer Runbook:

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
