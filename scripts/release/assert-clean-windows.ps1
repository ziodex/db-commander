$ErrorActionPreference = 'Stop'
$keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$existing = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Db Commander(?: [0-9].*)?$' }
if ($existing) { throw 'An existing Db Commander installation must not be touched.' }
