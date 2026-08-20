[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,

  [string]$IdentityPath,

  [string]$DatabasePath
)

$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ([string]::IsNullOrWhiteSpace($DatabasePath)) { $DatabasePath = Join-Path $projectRoot "data\money-manager.sqlite" }
$targetDatabase = [IO.Path]::GetFullPath($DatabasePath)
$projectPrefix = $projectRoot.TrimEnd("\") + "\"
if (-not $targetDatabase.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "安全限制：恢复目标必须位于项目目录内。"
}

$sourceBackup = (Resolve-Path -LiteralPath $BackupPath).Path
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("money-manager-restore-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

try {
  $candidate = $sourceBackup
  if ($sourceBackup.EndsWith(".age", [StringComparison]::OrdinalIgnoreCase)) {
    if ([string]::IsNullOrWhiteSpace($IdentityPath)) { throw "加密备份需要 -IdentityPath。" }
    $identity = (Resolve-Path -LiteralPath $IdentityPath).Path
    $age = Get-Command age -ErrorAction SilentlyContinue
    if (-not $age) { throw "未找到 age，无法解密。" }
    $candidate = Join-Path $temporaryDirectory "restored.sqlite"
    & $age.Source --decrypt -i $identity -o $candidate $sourceBackup
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $candidate)) { throw "备份解密失败。" }
  }

  & node (Join-Path $PSScriptRoot "verify-sqlite.mjs") $candidate
  if ($LASTEXITCODE -ne 0) { throw "备份没有通过 SQLite 完整性检查。" }

  $activeConnection = Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue
  if ($activeConnection) { throw "SMB 服务仍在运行。请先停止计划任务和手动服务后再恢复。" }

  if ($PSCmdlet.ShouldProcess($targetDatabase, "用已验证的备份替换主数据库")) {
    $targetDirectory = Split-Path -Parent $targetDatabase
    if (-not (Test-Path -LiteralPath $targetDirectory)) { New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null }
    if (Test-Path -LiteralPath $targetDatabase) {
      $safetyDirectory = Join-Path $projectRoot "backups\pre-restore"
      New-Item -ItemType Directory -Path $safetyDirectory -Force | Out-Null
      $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
      Copy-Item -LiteralPath $targetDatabase -Destination (Join-Path $safetyDirectory "money-before-restore-$stamp.sqlite")
    }
    Copy-Item -LiteralPath $candidate -Destination $targetDatabase -Force
    & node (Join-Path $PSScriptRoot "verify-sqlite.mjs") $targetDatabase
    if ($LASTEXITCODE -ne 0) { throw "恢复后的主库检查失败；请使用 pre-restore 安全副本。" }
    Write-Host "恢复完成并通过检查：$targetDatabase"
  }
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporaryDirectory)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemporary.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    }
  }
}
