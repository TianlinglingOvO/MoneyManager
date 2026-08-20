[CmdletBinding()]
param()

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $projectRoot ".env"
$serverEntry = Join-Path $projectRoot "dist-server\index.js"

if (-not (Test-Path -LiteralPath $environmentPath)) { throw "缺少 .env，请先完成本机配置。" }
if (-not (Test-Path -LiteralPath $serverEntry)) { throw "缺少生产构建，请先运行 npm.cmd run build。" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "未找到 Node.js。" }

$env:NODE_ENV = "production"
Set-Location -LiteralPath $projectRoot
& node $serverEntry
exit $LASTEXITCODE
