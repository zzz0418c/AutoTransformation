#Requires -Version 5.1
<#
.SYNOPSIS
  Start the local server (hidden) and open AutoTransformation as an app window.

.DESCRIPTION
  Uses Edge/Chrome `--app=` mode, so there is no address bar and no Electron.
  If the server is already running, it only opens the window.

  This script is what the desktop shortcut calls. Run it manually with
  -NoBrowser to check that the server starts.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\launch-app.ps1
  powershell -ExecutionPolicy Bypass -File scripts\launch-app.ps1 -NoBrowser
#>
param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:8787"
$dataDir = Join-Path $root "data"
$logFile = Join-Path $dataDir "launcher.log"

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Write-LauncherLog([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Test-App {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/config" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-App)) {
  Write-LauncherLog "starting local server"

  try {
    $node = (Get-Command node -ErrorAction Stop).Source
  } catch {
    Write-LauncherLog "node.exe not found on PATH"
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      "没有找到 Node.js。`n`n请先安装 Node.js 20+，或在项目目录运行 npm start 检查错误。",
      "AutoTransformation",
      "OK",
      "Error"
    ) | Out-Null
    exit 1
  }

  try {
    $startup = ([wmiclass]"Win32_ProcessStartup").CreateInstance()
    $startup.ShowWindow = 0
    $created = ([wmiclass]"Win32_Process").Create(
      ('"{0}" server/start.js' -f $node),
      $root,
      $startup
    )
    if ($created.ReturnValue -ne 0) {
      throw "Win32_Process.Create returned $($created.ReturnValue)"
    }
  } catch {
    Write-LauncherLog "failed to start server: $($_.Exception.Message)"
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      "本地服务没有启动成功。`n`n$($_.Exception.Message)`n`n请在项目目录运行 npm start 查看具体错误。",
      "AutoTransformation",
      "OK",
      "Error"
    ) | Out-Null
    exit 1
  }

  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-App) { break }
  }
}

if (-not (Test-App)) {
  Write-LauncherLog "server did not become ready"
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "本地服务没有启动成功。`n`n请在项目目录运行 npm start 查看具体错误，或查看：`n$logFile",
    "AutoTransformation",
    "OK",
    "Error"
  ) | Out-Null
  exit 1
}

Write-LauncherLog "server ready"

if ($NoBrowser) {
  exit 0
}

$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($browser) {
  Start-Process -FilePath $browser -ArgumentList @("--app=$url", "--window-size=1280,900")
  Write-LauncherLog "opened app window: $browser"
} else {
  Start-Process $url
  Write-LauncherLog "Edge/Chrome not found; opened default browser"
}
