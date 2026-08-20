[CmdletBinding(SupportsShouldProcess)]
param(
  [ValidateSet("deepseek-v4-flash", "deepseek-v4-pro")]
  [string]$Model = "deepseek-v4-flash",

  [ValidateSet("enabled", "disabled")]
  [string]$Thinking = "disabled"
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $projectRoot ".env"

if (-not (Test-Path -LiteralPath $environmentPath)) {
  throw "缺少本机配置 .env，请先完成 SMB 的本机部署。"
}

$secureKey = Read-Host "请粘贴 DeepSeek API Key（输入内容不会显示），然后按 Enter" -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$plainKey = $null

try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
  if ([string]::IsNullOrWhiteSpace($plainKey)) {
    throw "DeepSeek API Key 不能为空。"
  }

  $lines = [Collections.Generic.List[string]]::new()
  $lines.AddRange([string[]][IO.File]::ReadAllLines($environmentPath, [Text.Encoding]::UTF8))
  $foundKey = $false
  $foundModel = $false
  $foundThinking = $false

  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    if ($lines[$index] -match '^DEEPSEEK_API_KEY=') {
      $lines[$index] = "DEEPSEEK_API_KEY=$plainKey"
      $foundKey = $true
      continue
    }
    if ($lines[$index] -match '^DEEPSEEK_MODEL=') {
      $lines[$index] = "DEEPSEEK_MODEL=$Model"
      $foundModel = $true
      continue
    }
    if ($lines[$index] -match '^DEEPSEEK_THINKING=') {
      $lines[$index] = "DEEPSEEK_THINKING=$Thinking"
      $foundThinking = $true
    }
  }

  if (-not $foundKey) { $lines.Add("DEEPSEEK_API_KEY=$plainKey") }
  if (-not $foundModel) { $lines.Add("DEEPSEEK_MODEL=$Model") }
  if (-not $foundThinking) { $lines.Add("DEEPSEEK_THINKING=$Thinking") }

  if ($PSCmdlet.ShouldProcess($environmentPath, "保存 DeepSeek API Key")) {
    $utf8WithoutBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllLines($environmentPath, $lines, $utf8WithoutBom)
    Write-Host ""
    Write-Host "DeepSeek API Key 已安全写入本机配置。" -ForegroundColor Green
    Write-Host "模型：$Model"
    Write-Host "思考模式：$Thinking"
    Write-Host "密钥没有写入网页、数据库或日志。"
    Write-Host "请重启 SMB 服务后再进行 AI 分析。"
  }
} finally {
  $plainKey = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
}
