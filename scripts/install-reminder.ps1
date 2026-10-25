#Requires -Version 5.1
<#
.SYNOPSIS
  Register a daily Windows task that sends due vocabulary reminders.

.DESCRIPTION
  Runs `node scripts/notify.mjs` every day at the given time. The computer
  must be on at that time; for "computer off" reminders use the .ics export
  and import it into a calendar instead.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-reminder.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-reminder.ps1 -Time 08:00
#>
param(
  [string]$Time = "07:30",
  [string]$TaskName = "AutoTransformation-Reminder"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root "scripts\notify.mjs"

if (-not (Test-Path $script)) { throw "找不到 $script" }

$node = (Get-Command node -ErrorAction Stop).Source
Write-Host "Node: $node"
Write-Host "脚本: $script"

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description "AutoTransformation 生词本复习提醒" -Force | Out-Null

Write-Host ""
Write-Host "已注册计划任务：$TaskName（每天 $Time）"
Write-Host "立即测试：  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host "查看日志：  Get-Content `"$root\data\notify.log`" -Tail 20"
Write-Host "删除任务：  Unregister-ScheduledTask -TaskName `"$TaskName`" -Confirm:`$false"
Write-Host ""
Write-Host "注意：计划任务只在电脑开机时运行；关机也要提醒，请用生词本里的 .ics 导入日历。"
