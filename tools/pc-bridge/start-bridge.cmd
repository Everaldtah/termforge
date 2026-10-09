@echo off
rem Starts the TermForge PC bridge from this folder (double-click or run from a terminal).
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || exit /b 1
)
node bridge.mjs %*
