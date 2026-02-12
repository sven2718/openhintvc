# Stars in Shadow Developer Extension

This extension is your one-stop shop for Stars in Shadow development utilities!  It includes:

- Lua debugger: An evolution of devcat's excellent [lua debugger](https://github.com/devcat-studio/VSCodeLuaDebug), tweaked to work better with SiS's quirky runtime enviornement.
- OpenHint server:  A tiny integrated server that allows your running copy of Stars in Shadow to open files in VS Code.
- Lua go-to-definition: A lightweight `Ctrl+Click` / `F12` implementation for SiS Lua that understands common dialect patterns (locals/params even when used as the base of a member chain like `ship.empire`, module `_ENV`, `create_file_env`, `ensure_property_env`), plus workspace search heuristics and (when paused in the debugger) runtime `debug.getinfo` to jump to the exact definition line.
- Lua formatter: Minimal SiS-safe Lua formatting (default: whitespace normalization; optional: simple re-indent).
- Lua syntax diagnostics (prototype): Uses a background `sis_headless` process to run the real SiS Lua parser over open buffers and report syntax errors (dialect-aware).

## Debugging (Lua / SiS)

The launch config provided in your `Stars in Shadow\Lua state\.vscode` folder should work once this extension is installed (no separate debugger extension is required).

Typical configs use:
- `"type": "lua"`
-  Typical command line option include: 
    -  `-vscode` (enables the SiS Lua debugger)
    - `-console` (echo game engine outputs to a seperate term)
    -  `-debugbridge` (emulate msvc debug string handling).
- `listenPort`: SiS defaults to `46692` -- you probably want to keep that default.

## Stopping / restarting (Windows)

The adapter is intended to treat Stop Debugging as a hard stop: terminate the
launched process tree, close the debuggee connection, and end the session
promptly.  However, implementing this behavior robustly requires a relatively
recent build of SiS -- if you're running a version older than 1.5.0 -- you may
see issues where stopping the debugger does not quit the game.

## Lua breakpoints

This extension contributes Lua breakpoint support, so breakpoints should work normally in `lua` files. If VS Code still refuses to place breakpoints, make sure the file's language mode is set to Lua; as a fallback you can set `debug.allowBreakpointsEverywhere`.

## Formatting (Lua)

This extension provides a Lua formatter that avoids “fixing” SiS Lua dialect constructs.

- Set your default formatter for Lua to `Stars in Shadow Dev`.
- Configure behavior via `sisDev.luaFormatter.mode`:
  - `whitespace` (default): converts leading tabs to 2 spaces and otherwise preserves indentation (including whitespace-only lines); does not re-indent blocks (safest for SiS visual-indent conventions).
  - `simple`: re-indents using lightweight block keywords + `{}`, but preserves visually-shallow `| function` blocks (notably `UI_File | function(_ENV)`) and avoids flattening multiline continuations (`(...)`, `[...]`, and lines following a trailing `=`).

## Syntax diagnostics (SiS Lua) (prototype)

This extension can ask the real SiS Lua parser (via `sis_headless`) to syntax-check your buffers and surface errors as editor diagnostics.

- Enable/disable: `sisDev.luaSyntaxDiagnostics.enabled`
- Override executable path (optional): `sisDev.luaSyntaxDiagnostics.sisHeadlessPath`

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
