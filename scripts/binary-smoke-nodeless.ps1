# The ALP bundle on Windows without a system Node (t-1807): CI runs this on windows-2022 with PATH cut
# down to the Windows system directories, so no node can be found; the bundle's own node.exe runs ALP.
# scripts/binary-smoke.mjs (which needs Node for its fake provider and WebSocket client) covers the rest.
#
#   powershell -NoProfile -File scripts/binary-smoke-nodeless.ps1 path\to\alp-<version>-windows-x64\bin\alp.cmd
param([Parameter(Mandatory = $true)][string]$Binary)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Log([string]$Message) { Write-Host "[binary-smoke-nodeless] $Message" }
function Fail([string]$Message) { throw "[binary-smoke-nodeless] FAIL: $Message" }

$Binary = (Resolve-Path -LiteralPath $Binary).Path
$env:Path = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\Wbem;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
foreach ($tool in 'node', 'bun') { if (Get-Command $tool -ErrorAction SilentlyContinue) { Fail "$tool is on PATH ($env:Path); this smoke must run without it" } }
Log 'ok: no node or bun on PATH'

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("alp-nodeless-" + [System.Guid]::NewGuid().ToString('N'))
$env:ALP_HOME = Join-Path $work 'home'
$env:USERPROFILE = Join-Path $work 'user'
$env:HOME = $env:USERPROFILE
New-Item -ItemType Directory -Path $env:ALP_HOME, $env:USERPROFILE, (Join-Path $work 'project') | Out-Null
# Continue inside: Windows PowerShell 5.1 turns a native command's stderr into an error record under Stop.
function Alp { $ErrorActionPreference = 'Continue'; $out = & $Binary @args 2>&1 | Out-String; if ($LASTEXITCODE -ne 0) { Fail "alp $args exited $LASTEXITCODE`: $out" }; $out.Trim() }
try {
  $version = Alp --version
  if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+') { Fail "alp --version printed '$version'" }
  Log "ok: alp --version ($version)"

  $project = Join-Path $work 'project'
  Alp init $project | Out-Null
  if (-not ((Test-Path (Join-Path $project '.alp\ALP.md')) -or (Test-Path (Join-Path $project 'ALP.md')))) { Fail 'alp init did not write its templates' }
  Log 'ok: alp init writes its templates'

  if ((Alp daemon start) -notmatch 'running \(pid [0-9]+\)') { Fail 'alp daemon start' }
  Log 'ok: alp daemon start'
  if ((Alp daemon status) -notmatch 'ready') { Fail 'alp daemon status' }
  Log 'ok: alp daemon status'
  $bundle = Split-Path -Parent (Split-Path -Parent $Binary)
  if (-not (Test-Path (Join-Path $bundle 'lib\node_modules\node-pty\prebuilds\win32-x64'))) { Fail 'the bundle has no node-pty prebuild for win32-x64' }
  Log 'ok: the bundle carries node-pty for win32-x64'

  Push-Location $project
  try { $url = Alp web --print } finally { Pop-Location }
  if ($url -notmatch '^http://127\.0\.0\.1:[0-9]+/?#token=') { Fail "alp web --print printed '$url'" }
  $base = $url -replace '/?#.*$', ''
  if ((Invoke-WebRequest -Uri "$base/" -UseBasicParsing).StatusCode -ne 200) { Fail 'alp web does not serve its app' }
  $refused = 0
  try { Invoke-WebRequest -Uri "$base/v1/tickets" -Method Post -UseBasicParsing | Out-Null } catch { $refused = [int]$_.Exception.Response.StatusCode }
  if ($refused -ne 401) { Fail "a ticket without a token was answered $refused, not 401" }
  Log 'ok: alp web serves the app and gates tickets'
  $webJson = Join-Path $env:ALP_HOME 'web.json'
  if (Test-Path $webJson) { $webPid = (Get-Content $webJson -Raw | ConvertFrom-Json).pid; if ($webPid) { Stop-Process -Id $webPid -Force -ErrorAction SilentlyContinue } }

  if ((Alp daemon stop) -notmatch 'stopped') { Fail 'alp daemon stop' }
  Log 'ok: alp daemon stop'
  Log 'ok'
} finally {
  & $Binary daemon stop *> $null
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
