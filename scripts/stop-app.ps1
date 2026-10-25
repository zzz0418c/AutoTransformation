#Requires -Version 5.1
<#
.SYNOPSIS
  Stop the hidden AutoTransformation Node server on port 8787.

.DESCRIPTION
  Only stops the process if its command line contains server/start.js, so an
  unrelated program on the same port is left alone.
#>
$ErrorActionPreference = "Stop"

$connection = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1

if (-not $connection) {
  Write-Host "AutoTransformation 没有在运行。"
  exit 0
}

$ownerPid = $connection.OwningProcess
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid"

if ($process.CommandLine -like "*server/start.js*" -or $process.CommandLine -like "*server\start.js*") {
  Stop-Process -Id $ownerPid -Force
  Write-Host "已停止 AutoTransformation（PID $ownerPid）。"
} else {
  Write-Host "8787 被另一个进程占用（PID $ownerPid，$($process.Name)），没有动它。"
  Write-Host "命令行：$($process.CommandLine)"
}
