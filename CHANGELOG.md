# Change Log
All notable changes to the "openhintvc" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
