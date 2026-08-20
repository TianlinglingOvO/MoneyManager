@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\set-deepseek-key.ps1"
if errorlevel 1 (
  echo.
  echo 配置失败。请保留这个窗口并把错误文字发给 Codex。
  pause
  exit /b 1
)

echo.
echo 配置完成。请回到 Codex 告诉我“配置完成”，我会帮你安全重启并验证连接。
pause
exit /b 0
