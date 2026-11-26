<# ถอนการติดตั้งงานอัตโนมัติ (ไม่ลบข้อมูล/ไฟล์สำรอง)  Run as administrator #>
$ErrorActionPreference = 'Continue'
foreach ($n in 'IT-Helpdesk', 'IT-Helpdesk-Backup') {
  Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
}
Remove-NetFirewallRule -DisplayName 'IT Helpdesk' -ErrorAction SilentlyContinue
# งานรันอยู่ใต้ cmd -> node: ปิด node ที่รัน src\server.js ของโปรเจกต์นี้
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*src\server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host 'ถอนการติดตั้งแล้ว (โฟลเดอร์ data และไฟล์สำรองยังอยู่)'
