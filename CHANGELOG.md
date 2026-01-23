# Change Log
All notable changes to the "openhintvc" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
