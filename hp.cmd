@echo off
REM hp - one-command entry, works from any directory
setlocal
set "NODE_EXE=D:\project\hermes\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" "D:\project\deepseek_hreness\hermes-purge\bin\hp.js" %*
