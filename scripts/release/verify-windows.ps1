param([Parameter(Mandatory)][string]$Application, [Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
$publisher = $env:SQLCOMMANDER_SIGN_PUBLISHER
if ([string]::IsNullOrWhiteSpace($publisher)) { throw 'Missing expected signing publisher.' }
$files = @((Get-Item -LiteralPath $Application), (Get-Item -LiteralPath $Installer))
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $($file.Name)" }
  if ($signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne $publisher) { throw 'Unexpected signing publisher.' }
  if ($null -eq $signature.TimeStamperCertificate) { throw 'A timestamped signature is required.' }
}
Write-Host 'Application and installer Authenticode signatures, publisher, and timestamps verified.'
