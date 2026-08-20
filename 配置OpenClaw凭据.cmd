@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

wsl.exe -e bash /mnt/d/Application/MoneyManager/scripts/configure-openclaw-wsl.sh
if errorlevel 1 (
  echo.
  echo 配置失败。请保留这个窗口并把错误文字发给 Codex。
  pause
  exit /b 1
)

echo.
echo 凭据保存完成。可以关闭这个窗口，然后回到 Codex 继续配置 Cloudflare /mcp 应用。
pause
exit /b 0
