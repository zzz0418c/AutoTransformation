#Requires -Version 5.1
<#
.SYNOPSIS
  Create a desktop and Start Menu shortcut for AutoTransformation.

.DESCRIPTION
  The shortcut runs scripts\launch-app.ps1 hidden. That script starts the local
  Node server if needed, then opens Edge/Chrome in --app mode.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-desktop-app.ps1
#>
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root "scripts\launch-app.ps1"
$icon = Join-Path $root "public\icons\app.ico"

if (-not (Test-Path $launcher)) { throw "找不到 $launcher" }
if (-not (Test-Path $icon)) { throw "找不到 $icon" }

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""

$shell = New-Object -ComObject WScript.Shell

function New-AppShortcut([string]$path) {
  $shortcut = $shell.CreateShortcut($path)
  $shortcut.TargetPath = $powershell
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Description = "AutoTransformation 书页精读翻译"
  $shortcut.WindowStyle = 7
  $shortcut.Save()
}

$desktop = [Environment]::GetFolderPath("Desktop")
$desktopShortcut = Join-Path $desktop "AutoTransformation.lnk"
New-AppShortcut $desktopShortcut

$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$startShortcut = Join-Path $startMenu "AutoTransformation.lnk"
New-AppShortcut $startShortcut

Write-Host ""
Write-Host "已创建快捷方式："
Write-Host "  $desktopShortcut"
Write-Host "  $startShortcut"
Write-Host ""
Write-Host "双击桌面上的 AutoTransformation 即可启动（不会出现命令行窗口）。"
Write-Host "停止后台服务： powershell -ExecutionPolicy Bypass -File scripts\stop-app.ps1"
