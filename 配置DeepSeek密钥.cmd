@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\set-deepseek-key.ps1"
if errorlevel 1 (
  echo.
  echo 配置失败。请检查输入的密钥格式并重试。
  pause
  exit /b 1
)

echo.
echo 配置完成。重新启动 SMB 服务后即可生效。
pause
exit /b 0
