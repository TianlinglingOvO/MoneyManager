[CmdletBinding()]
param(
  [string]$Remote = "money-drive"
)

# 用自己在 Google Cloud 创建的“桌面应用”客户端重新连接 Google Drive。
# rclone 的公用 client_id 正在停用且经常额度耗尽，所以备份需要自己的客户端。
# 先不登录地保存客户端，再单独授权，最后核对授权确实来自这个客户端。

$rclone = Get-Command rclone -ErrorAction SilentlyContinue
if (-not $rclone) { throw "未找到 rclone。请先把 rclone.exe 放到 PATH 中的目录。" }
$configFile = (& $rclone.Source config file 2>$null | Select-Object -Last 1).Trim()
Write-Host "rclone 配置文件：$configFile" -ForegroundColor DarkGray

# 用假的 refresh token 询问 Google：密钥错误返回 invalid_client，密钥正确返回 invalid_grant。
function Test-ClientSecret([string]$Id, [string]$Secret) {
  try {
    Invoke-RestMethod -Uri "https://oauth2.googleapis.com/token" -Method Post -TimeoutSec 20 -Body @{
      client_id = $Id; client_secret = $Secret; refresh_token = "smb-probe"; grant_type = "refresh_token"
    } | Out-Null
    return "ok"
  } catch [System.Net.WebException] {
    $response = $_.Exception.Response
    if (-not $response) { return "network" }
    $body = (New-Object IO.StreamReader($response.GetResponseStream())).ReadToEnd()
    if ($body -match "invalid_client") { return "invalid_client" }
    return "ok"
  }
}

function Get-RemoteConfig {
  $dump = & $rclone.Source config dump 2>$null | Out-String | ConvertFrom-Json
  return $dump.$Remote
}

Write-Host "请粘贴 Google Cloud 中创建的“桌面应用”客户端信息。" -ForegroundColor Cyan
$clientId = (Read-Host "Client ID").Trim()
if ($clientId -notmatch '^\d+-[\w]+\.apps\.googleusercontent\.com$') { throw "Client ID 应形如 数字-字母.apps.googleusercontent.com，请检查是否复制完整。" }
$projectNumber = $clientId.Split("-")[0]

$secureSecret = Read-Host "Client secret（输入内容不会显示，粘贴后按 Enter）" -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
  $clientSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
  if ([string]::IsNullOrWhiteSpace($clientSecret)) { throw "Client secret 不能为空。" }

  # 0. 登录前先确认 Google 认可这个密钥；新建的密钥可能要几分钟才生效。
  $deadline = (Get-Date).AddMinutes(20)
  while ($true) {
    $check = Test-ClientSecret $clientId $clientSecret
    if ($check -eq "ok") { Write-Host "Google 已确认这个密钥有效。" -ForegroundColor Green; break }
    if ((Get-Date) -gt $deadline) { throw "等了 20 分钟 Google 仍不认可这个密钥。请在 Google Cloud 重新添加密钥后再运行本工具。" }
    if ($check -eq "network") { Write-Host "暂时连不上 Google，1 分钟后重试……" -ForegroundColor Yellow }
    else { Write-Host "Google 暂时还不认可这个密钥（新密钥可能要几分钟生效），1 分钟后自动重试……" -ForegroundColor Yellow }
    Start-Sleep -Seconds 60
  }

  # 1. 不登录，只保存客户端。
  & $rclone.Source config delete $Remote 2>$null
  & $rclone.Source config create $Remote drive scope=drive.file "client_id=$clientId" "client_secret=$clientSecret" --non-interactive 2>$null | Out-Null
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  Remove-Variable clientSecret -ErrorAction SilentlyContinue
}
$saved = Get-RemoteConfig
if (-not $saved -or $saved.client_id -ne $clientId -or -not $saved.client_secret) { throw "保存客户端信息失败，请截图这个窗口。" }
Write-Host "客户端信息已保存。" -ForegroundColor Green

# 2. 单独授权。
Write-Host ""
Write-Host "浏览器会打开 Google 登录页：" -ForegroundColor Cyan
Write-Host "  1. 选择你的 Google 账号。"
Write-Host "  2. 如果提示“Google 尚未验证此应用”，点“高级”，再点“转至 SMB Backup”。"
Write-Host "  3. 页面上应显示 SMB Backup 想要访问你的账号；点“继续”。"
Write-Host "  4. 看到 Success 页面后，回到这个窗口。"
Write-Host "  如果这个窗口问 y/n，直接按 Enter 用默认值。" -ForegroundColor DarkGray
& $rclone.Source config reconnect "$($Remote):"
if ($LASTEXITCODE -ne 0) { throw "授权没有完成，请重新运行本工具。" }

# 3. 核对：客户端还在，令牌来自这个客户端，并能访问 Drive。
$after = Get-RemoteConfig
if ($after.client_id -ne $clientId) { throw "授权后客户端信息丢失，请截图这个窗口。" }
$token = $after.token | ConvertFrom-Json
try {
  $info = Invoke-RestMethod -Uri "https://oauth2.googleapis.com/tokeninfo" -Method Post -Body @{ access_token = $token.access_token } -TimeoutSec 20
  if (-not $info.aud.StartsWith("$projectNumber-")) { throw "授权来自其他客户端，请重新运行本工具。" }
} catch [System.Net.WebException] {
  Write-Warning "无法向 Google 核对授权来源（网络问题），继续做连接测试。"
} finally {
  Remove-Variable token -ErrorAction SilentlyContinue
}

& $rclone.Source lsf "$($Remote):" --max-depth 1 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "授权已保存，但连接 Google Drive 测试失败。请确认代理已开启后重试。" }
Write-Host ""
Write-Host "Google Drive 授权完成，并已确认使用你自己的客户端（项目 $projectNumber）。" -ForegroundColor Green
