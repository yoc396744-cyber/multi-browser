@echo off
cd /d "%~dp0"
rem VS Code terminals set this, which makes Electron run as plain Node
set ELECTRON_RUN_AS_NODE=
if not exist node_modules\electron (
  echo Installing Electron, please wait...
  call npm install
)
call npx electron .
