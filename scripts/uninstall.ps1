$installDir = if ($env:AGENTICREMOTE_INSTALL_DIR) { $env:AGENTICREMOTE_INSTALL_DIR } else { Join-Path $HOME 'bin' }
$target = Join-Path $installDir 'agenticRemote'
if (Test-Path $target) { Remove-Item $target -Force }
Write-Host "removed $target"
