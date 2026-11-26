<#
 ติดตั้ง IT Helpdesk เป็นงานอัตโนมัติของ Windows (Task Scheduler)
   - รันตอนเปิดเครื่อง (ไม่ต้องล็อกอิน) ด้วยบัญชี SYSTEM และเริ่มใหม่เองถ้าโปรแกรมล่ม
   - สำรองฐานข้อมูลทุกวันเวลา 02:00
 วิธีใช้ (PowerShell แบบ Run as administrator ที่โฟลเดอร์โปรเจกต์):
   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 [-OpenFirewall] [-BackupTime 02:00]
#>
param(
  [switch]$OpenFirewall,
  [string]$BackupTime = '02:00'
)
$ErrorActionPreference = 'Stop'

$principalCheck = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'ต้องเปิด PowerShell แบบ Run as administrator'
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'ไม่พบ Node.js ติดตั้งจาก https://nodejs.org (เวอร์ชัน 22.13 ขึ้นไป, ตัว LTS) แล้วเปิด PowerShell ใหม่' }
$ver = [Version](& $node -p "process.versions.node")
if ($ver -lt [Version]'22.13.0') { throw "Node.js เวอร์ชัน $ver เก่าเกินไป ต้อง 22.13 ขึ้นไป" }

# ไฟล์ตั้งค่า
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root '.env.windows.example') $envFile
  Write-Host "สร้างไฟล์ตั้งค่า $envFile แล้ว (แก้ด้วย Notepad ได้ตามต้องการ)"
}
$port = 3000
$m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }

# จำกัดสิทธิ์ไฟล์ .env ให้เฉพาะผู้ดูแล + SYSTEM (มีรหัสผ่านเริ่มต้นได้)
& icacls $envFile /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null  # Administrators, SYSTEM (ใช้ SID กันปัญหาชื่อกลุ่มต่างภาษา)

function Register($name, $bat, $trigger, $settings) {
  $inner = '"{0}" "{1}"' -f (Join-Path $root "deploy\windows\$bat"), $node
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "{0}"' -f $inner) -WorkingDirectory $root
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}

$serverSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register 'IT-Helpdesk' 'run.bat' (New-ScheduledTaskTrigger -AtStartup) $serverSettings

$backupSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register 'IT-Helpdesk-Backup' 'backup.bat' (New-ScheduledTaskTrigger -Daily -At $BackupTime) $backupSettings

if ($OpenFirewall) {
  Remove-NetFirewallRule -DisplayName 'IT Helpdesk' -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName 'IT Helpdesk' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Domain,Private | Out-Null
  Write-Host "เปิดไฟร์วอลล์พอร์ต $port (เฉพาะเครือข่าย Domain/Private) แล้ว"
}

Start-ScheduledTask -TaskName 'IT-Helpdesk'
Start-Sleep -Seconds 4
Write-Host ''
Write-Host "ติดตั้งเสร็จ: เปิด http://localhost:$port"
Write-Host 'รหัสผ่านผู้ดูแลระบบ (admin) ครั้งแรก ดูได้ที่ไฟล์ logs\helpdesk.log (หาบรรทัดที่มี [setup]) — แสดงครั้งเดียว'
Write-Host "ดู log:  Get-Content '$root\logs\helpdesk.log' -Tail 30"
