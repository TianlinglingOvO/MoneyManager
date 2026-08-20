[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [string]$RecoveryKeyPath,

  [string]$RcloneRemote = "money-drive"
)

$ageKeygen = Get-Command age-keygen -ErrorAction SilentlyContinue
if (-not $ageKeygen) { throw "未找到 age-keygen。请先安装 age。" }
$rclone = Get-Command rclone -ErrorAction SilentlyContinue
if (-not $rclone) { throw "未找到 rclone。请先安装并运行 rclone config。" }

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $projectRoot ".env"
if (-not (Test-Path -LiteralPath $environmentPath)) { throw "请先运行 initialize-local-config.ps1 创建 .env。" }

$fullKeyPath = [IO.Path]::GetFullPath($RecoveryKeyPath)
if (Test-Path -LiteralPath $fullKeyPath) { throw "恢复密钥文件已经存在，已停止以防覆盖。" }
$keyDirectory = Split-Path -Parent $fullKeyPath
if (-not (Test-Path -LiteralPath $keyDirectory)) { New-Item -ItemType Directory -Path $keyDirectory -Force | Out-Null }

if ($PSCmdlet.ShouldProcess($fullKeyPath, "生成离线 age 恢复密钥")) {
  & $ageKeygen.Source -o $fullKeyPath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fullKeyPath)) { throw "恢复密钥生成失败。" }
  $recipient = (& $ageKeygen.Source -y $fullKeyPath | Select-Object -First 1).Trim()
  if ($recipient -notmatch "^age1") { throw "无法从恢复密钥读取公钥。" }

  $values = @{ BACKUP_AGE_RECIPIENT = $recipient; RCLONE_REMOTE = $RcloneRemote.Trim() }
  $updatedLines = foreach ($line in Get-Content -LiteralPath $environmentPath -Encoding UTF8) {
    if ($line -match "^([A-Z0-9_]+)=") {
      $name = $Matches[1]
      if ($values.ContainsKey($name)) { "$name=$($values[$name])"; continue }
    }
    $line
  }
  Set-Content -LiteralPath $environmentPath -Value $updatedLines -Encoding UTF8
  Write-Host "备份公钥已写入 .env。"
  Write-Warning "请把 $fullKeyPath 移出这台笔记本并安全保存；丢失后无法解密 Google Drive 备份。"
}
