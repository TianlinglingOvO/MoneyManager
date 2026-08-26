@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo SMB requires Node.js 22 or newer.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing SMB dependencies...
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
echo Building SMB...
call npm.cmd run build
if errorlevel 1 goto :failed

:built
curl.exe --silent --fail --max-time 1 "http://127.0.0.1:8788/health" >nul 2>&1
if errorlevel 1 (
  start "SMB Service - keep this window open" /D "%~dp0" cmd.exe /k "set NODE_ENV=production&& npm.cmd start"
  for /L %%i in (1,1,20) do (
    timeout /t 1 /nobreak >nul
    curl.exe --silent --fail --max-time 1 "http://127.0.0.1:8788/health" >nul 2>&1
    if not errorlevel 1 goto :ready
  )
  echo SMB did not start. Check the SMB Service window.
  pause
  exit /b 1
)

:ready
set "SMB_URL=http://127.0.0.1:8788"
if exist "%~dp0.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env") do (
    if /i "%%A"=="APP_URL" set "SMB_URL=%%B"
  )
)
start "" "%SMB_URL%"
exit /b 0

:failed
echo SMB startup failed. Keep this window open and send the error text to Codex.
pause
exit /b 1
