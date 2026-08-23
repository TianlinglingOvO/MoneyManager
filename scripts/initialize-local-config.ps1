[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[^@\s]+@[^@\s]+$")]
  [string]$AllowedEmail,

  [Parameter(Mandatory = $true)]
  [string]$CloudflareTeamDomain,

  [Parameter(Mandatory = $true)]
  [string]$WebAudience,

  [Parameter(Mandatory = $true)]
  [string]$McpAudience,

  [switch]$SkipDeepSeek
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$templatePath = Join-Path $projectRoot ".env.example"
$environmentPath = Join-Path $projectRoot ".env"

if (Test-Path -LiteralPath $environmentPath) {
  throw ".env 已存在。为避免覆盖密钥，请先人工备份或编辑现有文件。"
}

$secureDeepSeekKey = $null
$keyPointer = [IntPtr]::Zero
if (-not $SkipDeepSeek) {
  $secureDeepSeekKey = Read-Host "请输入 DeepSeek API Key（输入内容不会显示）" -AsSecureString
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureDeepSeekKey)
}
$randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()

try {
  $deepSeekKey = ""
  if (-not $SkipDeepSeek) {
    $deepSeekKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    if ([string]::IsNullOrWhiteSpace($deepSeekKey)) { throw "DeepSeek API Key 不能为空。" }
  }

  $tokenBytes = New-Object byte[] 48
  $randomGenerator.GetBytes($tokenBytes)
  $mcpToken = [Convert]::ToBase64String($tokenBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  $teamDomain = $CloudflareTeamDomain.Trim().Replace("https://", "").Replace("http://", "").TrimEnd("/")

  $values = @{
    AUTH_MODE = "cloudflare"
    CF_ACCESS_TEAM_DOMAIN = $teamDomain
    CF_ACCESS_AUD = $WebAudience.Trim()
    CF_ACCESS_MCP_AUD = $McpAudience.Trim()
    ALLOWED_EMAIL = $AllowedEmail.Trim().ToLowerInvariant()
    MCP_API_TOKEN = $mcpToken
    DEEPSEEK_API_KEY = $deepSeekKey.Trim()
  }

  $updatedLines = foreach ($line in Get-Content -LiteralPath $templatePath -Encoding UTF8) {
    if ($line -match "^([A-Z0-9_]+)=") {
      $name = $Matches[1]
      if ($values.ContainsKey($name)) { "$name=$($values[$name])"; continue }
    }
    $line
  }

  if ($PSCmdlet.ShouldProcess($environmentPath, "创建本机生产配置")) {
    Set-Content -LiteralPath $environmentPath -Value $updatedLines -Encoding UTF8
    Write-Host "已创建 $environmentPath"
    Write-Host "MCP 令牌已随机生成；请从 .env 复制到 OpenClaw 的 MONEY_MANAGER_MCP_TOKEN。"
  }
} finally {
  $randomGenerator.Dispose()
  if ($keyPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
}
