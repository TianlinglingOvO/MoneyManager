@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

for /f "usebackq delims=" %%i in (`wsl.exe wslpath -u "%~dp0scripts/configure-openclaw-wsl.sh"`) do set "WSL_SCRIPT=%%i"
wsl.exe -e bash "%WSL_SCRIPT%"
if errorlevel 1 (
  echo.
  echo 配置失败。请检查 WSL 运行状态与错误提示并重试。
  pause
  exit /b 1
)

echo.
echo 凭据保存完成。可关闭本窗口，并在 OpenClaw 中测试 MCP 连通性。
pause
exit /b 0
