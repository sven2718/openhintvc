# Change Log
All notable changes to the "openhintvc" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.1] - 2026-05-12
- Lua diagnostics: state transitions during `client.start()` are no longer dropped (status bar now reflects mid-startup activity).
- Lua diagnostics: 15s watchdog on `client.start()` surfaces a stuck initialize handshake as a visible failure instead of an indefinitely-spinning status bar.
- Lua diagnostics: trace-level logging through every step of `doStart`. Set `SIS_DEV_LOG_LEVEL=trace` for the full lifecycle + verbose JSON-RPC frame dumps in the SiS Lua LSP channel.

## [0.2.0] - 2026-05-12
- Lua diagnostics: status-bar item ("SiS Lua") now reflects LSP lifecycle (starting / running / unavailable / failed). Click to open the new "SiS Dev" output channel.
- Lua diagnostics: one-shot warning notification when start fails for an actionable reason (no `sis_headless` found, staging refused, init handshake rejected). Previously these failed silently and the channel was never created.
- More robust language server setup.

## [0.1.9] - 2026-05-05
- OpenHint server: changed default port from 62696 to 52698 (the old default fell inside a Windows/Hyper-V excluded port range, causing `EACCES` listen failures).
- OpenHint server: error messages now show the actual error code and cap retries at 3 attempts instead of looping forever. After exhausting retries, a final message explains the likely cause and how to retry manually.

## [0.1.8] - 2026-05-05
- Do nothing when visual studio code is not editing a SiS workspaces.

## [0.1.7] - 2026-04-24
- Rewiring the language server protocol.

## [0.1.6] - 2026-02-26
- Debugger: enable `evaluate` for hover tooltips (avoids stale values from the Variables view during stepping).

## [0.1.5] - 2026-02-12
- Lua syntax diagnostics (prototype): dialect-aware syntax checking via background `sis_headless` (snapshotted to a temp dir at startup to avoid build locks).
- Lua go-to-definition: when `sis_headless` is available, local-scope analysis can use the real SiS Lua lexer via the background process (falls back to a lightweight TypeScript tokenizer).
- Lua syntax diagnostics: auto-detect `sis_headless.exe` from mod-kit workspaces where the folder is `Lua state/`.

## [0.1.4] - 2026-02-10
- Lua go-to-definition: resolve locals/params/upvalues (including when used as the base of a member chain like `ship.empire`), with improved file-local definition scanning.

## [0.1.3] - 2026-01-29
- Debugger (Windows): if the game can't process `sis_exit` promptly (e.g. during galaxy generation), force-kill the launched process while keeping the integrated terminal shell alive.

## [0.1.2] - 2026-01-29
- Debugger (Windows): avoid killing the integrated terminal shell on stop (prevents the recurring “terminal process ... terminated with exit code: 1” popup).
- Debugger: stopping before the debuggee connects no longer reports a failed launch response (avoids the modal “Debug Session Canceled” beep).

## [0.1.1] - 2026-01-23
- Added a basic Lua go-to-definition provider (heuristic grep, with runtime `debug.getinfo` lookup when paused in the debugger).
- Lua go-to-definition: avoid `stackTrace`-dependent runtime lookups (prevents debuggee errors when the game isn't paused).
- Debugger manifest: switched to `contributes.breakpoints` and replaced `${workspaceRoot}` with `${workspaceFolder}`.
- Debugger: on Windows, Shift+F5 now terminates `sis.exe` even when launched via `runInTerminal` (kills the process tree).

## [0.1.0] - 2026-01-22
- Debugger: wrapped Windows GUI targets with `cmd.exe /c` for `integratedTerminal` so `-console` sessions behave properly.
- Debugger: added Linux executable paths for the default SiS launch configs.
- Dependencies: `npm audit --fix` updates.

## [0.0.37] - 2026-01-19
- Updated default launch configs/docs to use `-vscode` (the Leviathan-side debug flag; renamed from `-devcat`).

## [0.0.36] - 2026-01-18
- Replaced the vendored C#/Mono Lua debug adapter with a Node/TypeScript adapter (better Linux story, no C# deps).
- Renamed commands to `SiS Dev: ...` for clarity.

## [0.0.35] - 2025-10-23
- Updated for 2025-era VS Code.

## [0.0.32]
- Initial release
