# Bootstrap - ASCII only, loads main script with explicit UTF-8
# Fixes PowerShell 5.1 encoding: -File reads as system default, so we read UTF-8 and invoke
$ErrorActionPreference = "Continue"
try { chcp 65001 | Out-Null } catch {}
$utf8 = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
$OutputEncoding = $utf8

$mainScript = Join-Path $PSScriptRoot "OpenClaw_Shell.ps1"
if (-not (Test-Path $mainScript)) {
  Write-Host "Error: OpenClaw_Shell.ps1 not found" -ForegroundColor Red
  Read-Host "Press Enter to exit"
  exit 1
}
# Read as UTF-8, write temp with BOM, dot-source (avoids -File default encoding)
$content = [System.IO.File]::ReadAllText($mainScript, $utf8)
$utf8Bom = New-Object System.Text.UTF8Encoding $true
$tmp = [System.IO.Path]::GetTempFileName() + ".ps1"
[System.IO.File]::WriteAllText($tmp, $content, $utf8Bom)
try {
  . $tmp @args
} catch {
  Write-Host ""
  $msg = $_.Exception.Message
  Write-Host "`[Error`] Script failed: $msg" -ForegroundColor Red
  Write-Host "If encoding issue, ensure OpenClaw_Shell.ps1 is UTF-8 with BOM" -ForegroundColor Yellow
  Read-Host "Press Enter to exit"
  exit 1
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
