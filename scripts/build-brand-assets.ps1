[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicPath = Join-Path $projectRoot "public"
Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
  param([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius)
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-MarkPath {
  param([string]$Part)
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  if ($Part -eq "S") {
    $path.StartFigure()
    $path.AddLine(66, 49, 43, 49)
    $path.AddBezier(43, 49, 33, 49, 27, 55, 27, 64)
    $path.AddBezier(27, 64, 27, 73, 34, 79, 44, 79)
    $path.AddLine(44, 79, 51, 79)
    $path.AddBezier(51, 79, 62, 79, 69, 86, 69, 96)
    $path.AddBezier(69, 96, 69, 106, 62, 114, 50, 114)
    $path.AddLine(50, 114, 27, 114)
  } elseif ($Part -eq "M") {
    $path.StartFigure()
    $path.AddLine(85, 119, 85, 49)
    $path.AddLine(85, 49, 105, 76)
    $path.AddLine(105, 76, 125, 49)
    $path.AddLine(125, 49, 125, 119)
  } else {
    $path.StartFigure()
    $path.AddLine(125, 49, 137, 49)
    $path.AddBezier(137, 49, 149, 49, 157, 56, 157, 67)
    $path.AddBezier(157, 67, 157, 76, 151, 82, 142, 84)
    $path.AddBezier(142, 84, 153, 86, 160, 93, 160, 103)
    $path.AddBezier(160, 103, 160, 115, 151, 123, 137, 123)
    $path.AddLine(137, 123, 125, 123)
  }
  return $path
}

function Write-BrandPng {
  param([int]$Size, [string]$FileName, [bool]$Maskable)
  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $scale = $Size / 180.0
  $graphics.ScaleTransform($scale, $scale)

  $purple = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#291D3A"))
  if ($Maskable) {
    $graphics.FillRectangle($purple, 0, 0, 180, 180)
  } else {
    $background = New-RoundedRectanglePath -X 2 -Y 2 -Width 176 -Height 176 -Radius 40
    $graphics.FillPath($purple, $background)
    $background.Dispose()
  }

  $pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#FFF3E4"), 16)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  foreach ($part in @("S", "M", "B")) {
    $markPath = New-MarkPath -Part $part
    $graphics.DrawPath($pen, $markPath)
    $markPath.Dispose()
  }
  $coral = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#F06B55"))
  $graphics.FillEllipse($coral, 117, 76, 16, 16)

  $target = Join-Path $publicPath $FileName
  $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $coral.Dispose()
  $pen.Dispose()
  $purple.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-BrandPng -Size 192 -FileName "smb-pwa-192-v2.png" -Maskable $false
Write-BrandPng -Size 512 -FileName "smb-pwa-512-v2.png" -Maskable $false
Write-BrandPng -Size 512 -FileName "smb-maskable-512-v2.png" -Maskable $true
Write-Output "SMB brand PNG assets generated in $publicPath"
