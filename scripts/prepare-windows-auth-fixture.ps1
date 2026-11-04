# Fixture for the opt-in Windows diagnostics workflow.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'X64' -or -not $env:RUNNER_TEMP) {
    throw 'This SQL Server fixture requires a disposable GitHub-hosted Windows x64 runner.'
}
if ((Get-Service -Name 'MSSQLSERVER' -ErrorAction SilentlyContinue) -or
    (Get-NetTCPConnection -State Listen -LocalPort 1433 -ErrorAction SilentlyContinue)) {
    throw 'The default SQL Server service or its fixture port is already in use.'
}

function Assert-MicrosoftSignature([string] $File) {
    $signature = Get-AuthenticodeSignature -LiteralPath $File
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo('SimpleName', $false) -ne 'Microsoft Corporation') {
        throw "Invalid Microsoft signature for $(Split-Path -Leaf $File)."
    }
}

function Invoke-Setup([string] $File, [string[]] $Arguments) {
    $result = Start-Process -FilePath $File -ArgumentList $Arguments -NoNewWindow -Wait -PassThru
    if ($result.ExitCode -ne 0) { throw "$(Split-Path -Leaf $File) returned exit code $($result.ExitCode)." }
}

# Microsoft SQL Server 2025 Express download center, version 17.0.1000.9.
$fixture = Join-Path $env:RUNNER_TEMP 'dbcommander-windows-auth'
$media = New-Item -ItemType Directory -Path (Join-Path $fixture 'media') -Force
$download = Join-Path $fixture 'SQL2025-SSEI-Expr.exe'
Invoke-WebRequest -UseBasicParsing -Uri 'https://download.microsoft.com/download/2e652cd0-da06-4fc0-836a-b75ec45035a9/SQL2025-SSEI-Expr.exe' -OutFile $download
if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne 'fa7e1fabc9a2e9c9cdab0d1512bcb30d2949133147db057ac530f510e5270680') {
    throw 'SQL Server Express bootstrapper did not match the pinned hash.'
}
Assert-MicrosoftSignature $download
Invoke-Setup $download @('/Action=Download', '/MediaType=Core', "/MediaPath=`"$($media.FullName)`"", '/Quiet')
$archive = @(Get-ChildItem -LiteralPath $media.FullName -Filter 'SQLEXPR_x64_ENU.exe' -File -Recurse)
if ($archive.Count -ne 1) { throw 'Expected one SQL Server Express Core archive.' }
Assert-MicrosoftSignature $archive[0].FullName
$extracted = New-Item -ItemType Directory -Path (Join-Path $fixture 'setup')
Invoke-Setup $archive[0].FullName @('/q', "/x:`"$($extracted.FullName)`"")
$setup = Join-Path $extracted.FullName 'setup.exe'
Assert-MicrosoftSignature $setup

# Use the Windows runner account and Windows-only auth on the local fixture.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
Invoke-Setup $setup @('/Q', '/ACTION=Install', '/FEATURES=SQLEngine', '/INSTANCENAME=MSSQLSERVER',
    '/SQLSVCSTARTUPTYPE=Automatic', '/TCPENABLED=1', '/NPENABLED=0', '/UPDATEENABLED=False',
    "/SQLSYSADMINACCOUNTS=`"$identity`"", '/IACCEPTSQLSERVERLICENSETERMS')
(Get-Service -Name 'MSSQLSERVER').WaitForStatus('Running', [TimeSpan]::FromSeconds(30))

# Check the same OS authentication and TCP route that the product uses.
Add-Type -AssemblyName System.Data
$connection = New-Object System.Data.SqlClient.SqlConnection 'Server=tcp:localhost,1433;Database=master;Integrated Security=SSPI;Encrypt=False;Connect Timeout=15'
try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandText = 'SELECT ORIGINAL_LOGIN(), auth_scheme, net_transport, local_tcp_port FROM sys.dm_exec_connections WHERE session_id = @@SPID'
    $row = $command.ExecuteReader()
    if (-not $row.Read() -or $row.GetString(0) -ne $identity -or $row.GetString(1) -notin @('NTLM', 'KERBEROS') -or
        $row.GetString(2) -ne 'TCP' -or $row.GetInt32(3) -ne 1433) {
        throw 'The fixture did not authenticate the current Windows account over its expected TCP route.'
    }
    Write-Host "SQL Server $($connection.ServerVersion): current-account $($row.GetString(1)) over TCP verified."
} finally {
    $connection.Dispose()
}
