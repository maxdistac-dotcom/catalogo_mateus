param(
  [Parameter(Position = 0)]
  [string]$Command = "scrape",

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BundledNode = "C:\Users\Max\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Node = if (Test-Path -LiteralPath $BundledNode) { $BundledNode } else { (Get-Command node -ErrorAction Stop).Source }

Set-Location $ProjectRoot
& $Node (Join-Path $ProjectRoot "scripts\mateus-scraper.mjs") $Command @ExtraArgs
exit $LASTEXITCODE
