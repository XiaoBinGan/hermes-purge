@echo off
REM hp - one-command entry; works from any working directory
REM path is resolved from %~dp0 so it is relocatable (no hardcoded drive)
setlocal
set "NODE_EXE=node"
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
"%NODE_EXE%" "%~dp0bin\hp.js" %*
