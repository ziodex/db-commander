param([Parameter(Mandatory = $true)][string]$Installation)
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:SQLCOMMANDER_DISPOSABLE_INSTALL_TEST -ne '1') {
  throw 'Uninstall lock checks require a disposable Windows test worker.'
}
$executable = Join-Path $Installation 'DbCommander.exe'
$uninstaller = @(Get-ChildItem -LiteralPath $Installation -Filter 'Uninstall*.exe')
if ($uninstaller.Count -ne 1) { throw 'Expected one installed uninstaller.' }
$resources = Join-Path $Installation 'resources\app.asar'
$before = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash
$resourcesBefore = (Get-FileHash -LiteralPath $resources -Algorithm SHA256).Hash
$registrations = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { $_.GetValue('DisplayName') -eq 'Db Commander' } | Select-Object -ExpandProperty PSPath)
if ($registrations.Count -ne 1) { throw 'Expected one current-user installer registration.' }
$registrationBefore = Get-ItemProperty -LiteralPath $registrations[0] | Select-Object DisplayName, DisplayVersion, UninstallString, InstallLocation | ConvertTo-Json -Compress

function Start-Uninstall {
  Start-Process -FilePath $uninstaller[0].FullName -ArgumentList "/S /currentuser _?=$Installation" -PassThru
}

# Deny deletion without running the app. A persistent lock must fail before
# removing any other files or registration, so the user can retry normally.
$lock = [System.IO.File]::Open($executable, 'Open', 'Read', 'Read')
try {
  $process = Start-Uninstall
  if (-not $process.WaitForExit(20000)) { $process.Kill(); throw 'Locked uninstall timed out.' }
  if ($process.ExitCode -ne 3) { throw "A persistent file lock must refuse uninstall with exit code 3; got $($process.ExitCode)." }
  if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ne $before -or (Get-FileHash -LiteralPath $resources -Algorithm SHA256).Hash -ne $resourcesBefore) { throw 'Refused uninstall changed application files.' }
  foreach ($registration in $registrations) { if (-not (Test-Path -LiteralPath $registration)) { throw 'Refused uninstall removed its registration.' } }
  $registrationAfter = Get-ItemProperty -LiteralPath $registrations[0] | Select-Object DisplayName, DisplayVersion, UninstallString, InstallLocation | ConvertTo-Json -Compress
  if ($registrationAfter -ne $registrationBefore) { throw 'Refused uninstall changed its registration.' }
} finally { $lock.Dispose() }

# A short-lived scanner/native-image handle must be retried by the installer,
# rather than reported as a successful uninstall with an executable left behind.
$lock = [System.IO.File]::Open($executable, 'Open', 'Read', 'Read')
try {
  $process = Start-Uninstall
  if ($process.WaitForExit(1500)) { throw 'Uninstall returned while its executable was still locked.' }
} finally { $lock.Dispose() }
if (-not $process.WaitForExit(20000)) { $process.Kill(); throw 'Uninstall did not finish after the file lock was released.' }
if ($process.ExitCode -ne 0 -or (Test-Path -LiteralPath $executable)) { throw 'Uninstall did not remove the executable after lock release.' }
foreach ($registration in $registrations) { if (Test-Path -LiteralPath $registration) { throw 'Successful uninstall retained its registration.' } }
Write-Output 'NSIS persistent-lock refusal and transient-lock recovery passed.'
