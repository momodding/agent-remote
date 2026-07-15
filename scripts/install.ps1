param(
  [Parameter(Mandatory = $true)] [string]$Archive,
  [Parameter(Mandatory = $true)] [string]$Manifest
)

$line = Get-Content $Manifest | Where-Object { $_ -match [regex]::Escape((Split-Path $Archive -Leaf)) } | Select-Object -First 1
if (-not $line) { throw "archive hash not found in manifest" }
$parts = $line -split '\s+'
$expected = $parts[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw "sha256 mismatch" }

$temp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $temp | Out-Null
Expand-Archive -Path $Archive -DestinationPath $temp -Force
$installDir = if ($env:AGENTICREMOTE_INSTALL_DIR) { $env:AGENTICREMOTE_INSTALL_DIR } else { Join-Path $HOME 'bin' }
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$binary = Get-ChildItem -Path $temp -Recurse -Filter agenticRemote.exe | Select-Object -First 1
if (-not $binary) { $binary = Get-ChildItem -Path $temp -Recurse -Filter agenticRemote | Select-Object -First 1 }
Copy-Item $binary.FullName (Join-Path $installDir 'agenticRemote') -Force
Write-Host "installed $(Join-Path $installDir 'agenticRemote')"
