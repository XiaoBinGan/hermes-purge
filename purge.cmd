@echo off
REM purge - hermes-purge v2 engine launcher (works from any directory)
REM %~dp0 resolves to the directory holding this .cmd, so the repo can move.
node "%~dp0bin\purge.js" %*
