@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing application dependencies...
  call npm.cmd install
  if errorlevel 1 goto :failed
)

if not exist ".env" (
  echo Missing local production configuration: .env
  echo Please ask Codex to restore the local configuration.
  pause
  exit /b 1
)

if not exist "dist-server\index.js" goto :build
if not exist "dist\index.html" goto :build
goto :built

:build
(
  echo Building the application...
  call npm.cmd run build
  if errorlevel 1 goto :failed
)

:built

curl.exe --silent --fail --max-time 1 "http://127.0.0.1:8788/health" >nul 2>&1
if errorlevel 1 (
  start "Money Manager Service - keep this window open" /D "%~dp0" cmd.exe /k "set NODE_ENV=production&& npm.cmd start"
  for /L %%i in (1,1,20) do (
    timeout /t 1 /nobreak >nul
    curl.exe --silent --fail --max-time 1 "http://127.0.0.1:8788/health" >nul 2>&1
    if not errorlevel 1 goto :ready
  )
  echo The service did not start. Check the Money Manager Service window.
  pause
  exit /b 1
)

:ready
start "" "https://money.sutady.top"
exit /b 0

:failed
echo Startup failed. Keep this window open and send the error text to Codex.
pause
exit /b 1
