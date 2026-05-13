$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BundledNode = "C:\Users\Max\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Node = if (Test-Path -LiteralPath $BundledNode) { $BundledNode } else { (Get-Command node -ErrorAction Stop).Source }
$LogDir = Join-Path $ProjectRoot "saida"
$LogPath = Join-Path $LogDir "ultimo-run.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $ProjectRoot

& $Node (Join-Path $ProjectRoot "scripts\mateus-scraper.mjs") scrape *> $LogPath
exit $LASTEXITCODE
