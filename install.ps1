# Installs ALP on Windows x64 (t-1807, docs/alp/binary-install.md; best-effort). The release archive
# is the ALP bundle (ALP with the Node release it runs on): it goes to <Root>\app\<version>, the
# junction <Root>\app\current points at it, and <Dir>\alp.cmd runs it.
#
#   irm https://github.com/phucanh08/alp/releases/latest/download/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://github.com/phucanh08/alp/releases/latest/download/install.ps1))) -Version 0.0.1-beta.7
#
# Options (or the environment variables in brackets, which also work with `| iex`):
#   -Version <v>     install release v<v> instead of the latest      [ALP_INSTALL_VERSION]
#   -Dir <path>      put the alp command (alp.cmd) in <path>          [ALP_INSTALL_DIR]
#                    (default %LOCALAPPDATA%\Programs\alp, else ~\.alp\bin)
#   -Root <path>     put the bundle in <path>\app (default: -Dir)     [ALP_INSTALL_ROOT]
#   -NoModifyPath    leave the user PATH alone and only print the step [ALP_INSTALL_NO_MODIFY_PATH=1]
#   -BaseUrl <url>   read SHA256SUMS and the archive from a mirror     [ALP_INSTALL_BASE_URL]
#                    (https://, file:// or an absolute directory)
#   -Help
#
# It downloads SHA256SUMS, takes alp-<version>-windows-x64.zip from it, checks the archive's sha256
# with Get-FileHash before extracting anything, unblocks it (Mark of the Web), unpacks it beside the
# installed versions and moves it into place, switches app\current, writes alp.cmd (moving the
# alp.exe of a 0.0.1-beta.5/6 single-file install aside), adds the directory to the user PATH once,
# and runs `alp --version`.
[CmdletBinding()]
param(
  [string]$Version = $env:ALP_INSTALL_VERSION,
  [string]$Dir = $env:ALP_INSTALL_DIR,
  [string]$Root = $env:ALP_INSTALL_ROOT,
  [switch]$NoModifyPath,
  [string]$BaseUrl = $env:ALP_INSTALL_BASE_URL,
  [switch]$Help
)

# The body runs in a child scope (& { }): under `| iex` its variables and preferences
# ($ErrorActionPreference, $ProgressPreference) stay out of the caller's session.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $Repo = 'phucanh08/alp'

  function Say([string]$Message) { Write-Host "alp-install: $Message" }
  # Throw, never exit: under `irm ... | iex` an exit would close the user's PowerShell. Run as a file
  # (powershell -File install.ps1) an uncaught throw still ends with exit code 1.
  function Die([string]$Message) { throw "alp-install: error: $Message" }

  if ($Help) {
    Write-Host 'Usage: install.ps1 [-Version <v>] [-Dir <path>] [-Root <path>] [-NoModifyPath] [-BaseUrl <url or dir>]'
    return
  }
  if ($env:ALP_INSTALL_NO_MODIFY_PATH -eq '1') { $NoModifyPath = $true }

  # --- platform --------------------------------------------------------------------------------
  $onWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
  if (-not $onWindows) { Die 'install.ps1 is for Windows; on macOS and Linux use install.sh' }
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { }
    'ARM64' { Say 'warning: no Windows arm64 build yet; installing the x64 build, which runs under emulation' }
    default { Die "unsupported architecture $arch (ALP ships Windows x64 only)" }
  }
  $platform = 'windows-x64'

  # --- options ---------------------------------------------------------------------------------
  if ($Version) {
    $Version = $Version -replace '^v', ''
    if (-not $Version) { Die '-Version needs a value' }
    if ($Version -notmatch '^[0-9][0-9A-Za-z.+-]*$') { Die "invalid version '$Version'" }
  }
  if (-not $BaseUrl) {
    if ($Version) { $BaseUrl = "https://github.com/$Repo/releases/download/v$Version" }
    else { $BaseUrl = "https://github.com/$Repo/releases/latest/download" }
  }
  $BaseUrl = $BaseUrl.TrimEnd('/', '\')
  # A local mirror: an absolute directory or a file:// URL.
  $localMirror = $null
  if ($BaseUrl -match '^file://') { $localMirror = ([System.Uri]$BaseUrl).LocalPath }
  elseif ([System.IO.Path]::IsPathRooted($BaseUrl) -and $BaseUrl -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]+://') { $localMirror = $BaseUrl }
  elseif ($BaseUrl -notmatch '^https://') { Die "the release mirror must be https://, file:// or an absolute directory ($BaseUrl)" }

  if (-not $Dir) {
    if ($env:LOCALAPPDATA) { $Dir = Join-Path $env:LOCALAPPDATA 'Programs\alp' }
    else { $Dir = Join-Path $HOME '.alp\bin' }
  }
  if ($Dir.Contains(';')) { Die "-Dir cannot contain ';' (it would split PATH): $Dir" }
  $Dir = [System.IO.Path]::GetFullPath($Dir)
  if (-not $Root) { $Root = $Dir }
  $Root = [System.IO.Path]::GetFullPath($Root)
  $App = Join-Path $Root 'app'

  if ($PSVersionTable.PSVersion.Major -lt 6) {
    # Windows PowerShell 5.1 may default to TLS 1.0; GitHub needs 1.2.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }

  function Fetch([string]$Name, [string]$Target) {
    if ($localMirror) {
      $source = Join-Path $localMirror $Name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "no $source" }
      Copy-Item -LiteralPath $source -Destination $Target -Force
    } else {
      Invoke-WebRequest -Uri "$BaseUrl/$Name" -OutFile $Target -UseBasicParsing
    }
  }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("alp-install-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    # --- download and verify -------------------------------------------------------------------
    Say "downloading SHA256SUMS from $BaseUrl"
    $sumsFile = Join-Path $tmp 'SHA256SUMS'
    try { Fetch 'SHA256SUMS' $sumsFile } catch { Die "could not download $BaseUrl/SHA256SUMS ($($_.Exception.Message))" }
    $suffix = "-$platform.zip"
    $entries = @()
    foreach ($row in Get-Content -LiteralPath $sumsFile) {
      $parts = $row.Trim() -split '\s+', 2
      if ($parts.Count -ne 2) { continue }
      $name = $parts[1].TrimStart('*')
      if ($Version) { if ($name -eq "alp-$Version$suffix") { $entries += , @($parts[0], $name) } }
      elseif ($name -match '^alp-[0-9]' -and $name.EndsWith($suffix)) { $entries += , @($parts[0], $name) }
    }
    if ($entries.Count -eq 0) { Die "this release has no build for $platform" }
    if ($entries.Count -gt 1) { Die "SHA256SUMS lists more than one $platform archive" }
    $expected = $entries[0][0].ToLowerInvariant()
    $asset = $entries[0][1]
    if ($asset -notmatch '^[0-9A-Za-z.+_-]+$') { Die "unexpected archive name in SHA256SUMS: $asset" }
    if ($expected -notmatch '^[0-9a-f]{64}$') { Die "malformed checksum for $asset" }

    Say "downloading $asset"
    $zip = Join-Path $tmp $asset
    try { Fetch $asset $zip } catch { Die "could not download $BaseUrl/$asset ($($_.Exception.Message))" }
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Die "checksum mismatch for $asset (expected $expected, got $actual)" }
    Say "checksum verified ($expected)"
    Unblock-File -LiteralPath $zip

    $name = $asset.Substring(0, $asset.Length - '.zip'.Length)
    $newVersion = $name.Substring('alp-'.Length, $name.Length - 'alp-'.Length - "-$platform".Length)

    # --- install -------------------------------------------------------------------------------
    try { New-Item -ItemType Directory -Path $App -Force | Out-Null; New-Item -ItemType Directory -Path $Dir -Force | Out-Null } catch { Die "could not create $App or $Dir" }
    $current = Join-Path $App 'current'
    $previous = $null
    $aside = $null
    # The version a running alpd uses (its lock names it): its files must stay.
    $alpdVersion = $null
    $alpHome = if ($env:ALP_HOME) { $env:ALP_HOME } else { Join-Path $HOME '.alp' }
    try {
      $lock = Get-Content -Raw -LiteralPath (Join-Path $alpHome 'alpd.lock') -ErrorAction Stop | ConvertFrom-Json
      if ($lock.pid -and (Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue)) { $alpdVersion = [string]$lock.version }
    } catch { }
    $currentItem = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($currentItem) {
      if (-not $currentItem.LinkType) { Die "$current exists and is not a junction; move it away and rerun" }
      $previous = Split-Path -Leaf ([string]$currentItem.Target)
    }
    # Unpack beside the versions, then move into place: no half-written version is ever current.
    $stage = Join-Path $App (".alp-update-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 12))
    try {
      New-Item -ItemType Directory -Path $stage | Out-Null
      # Windows' bsdtar unpacks the bundle's thousands of files much faster than Expand-Archive.
      $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
      if (Test-Path -LiteralPath $tar) { & $tar -xf $zip -C $stage; if ($LASTEXITCODE -ne 0) { Die "could not extract $asset" } }
      else { Expand-Archive -LiteralPath $zip -DestinationPath $stage }
      $unpacked = Join-Path $stage $name
      if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'alp-bundle.json') -PathType Leaf)) { Die "$asset does not contain an ALP bundle ($name\alp-bundle.json)" }
      $node = Join-Path $unpacked 'node\node.exe'
      $cli = Join-Path $unpacked 'lib\node_modules\@anhlp\alp-cli\dist\cli.js'
      $reported = (& $node $cli --version | Out-String).Trim()
      if ($reported -ne $newVersion) { Die "the downloaded ALP reports version '$reported', not $newVersion" }
      $target = Join-Path $App $newVersion
      if (Test-Path -LiteralPath $target) {
        if ($previous -eq $newVersion -or $alpdVersion -eq $newVersion) {
          # Reinstalling the running version: keep its files for the processes that use them.
          $aside = ".alp-old-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 12)
          try { Move-Item -LiteralPath $target -Destination (Join-Path $App $aside) } catch { Die "ALP $newVersion is in use (Windows cannot move a running version); close ALP (alp daemon stop) and rerun" }
        } else { Remove-Item -LiteralPath $target -Recurse -Force }
      }
      Move-Item -LiteralPath $unpacked -Destination $target
    } catch {
      $reason = $_.Exception.Message
      # The running version goes back where it was, so app\current still points at files (t-1f14).
      if ($aside -and -not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath (Join-Path $App $aside) -Destination $target -ErrorAction SilentlyContinue }
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
      if ($reason -like 'alp-install:*') { throw }
      Die "could not install $App\$newVersion ($reason)"
    }
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    # Point current at the new version: a junction (no administrator rights needed).
    $previousTarget = $null
    if ($currentItem) { $previousTarget = [string]$currentItem.Target; [System.IO.Directory]::Delete($current, $false) }
    try { New-Item -ItemType Junction -Path $current -Target $target | Out-Null } catch {
      $reason = $_.Exception.Message
      if ($previousTarget) { New-Item -ItemType Junction -Path $current -Target $previousTarget -ErrorAction SilentlyContinue | Out-Null }
      Die "could not point $current at $target ($reason)"
    }
    Say "installed ALP $newVersion in $target"

    # The alp command. A 0.0.1-beta.5/6 alp.exe would win over alp.cmd on PATH: move it aside (a
    # running alp.exe can be renamed, not deleted) and remove earlier leftovers.
    Get-ChildItem -LiteralPath $Dir -Filter 'alp.exe.old-*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    $exe = Join-Path $Dir 'alp.exe'
    if (Test-Path -LiteralPath $exe) {
      try { Move-Item -LiteralPath $exe -Destination (Join-Path $Dir ("alp.exe.old-" + [DateTime]::UtcNow.Ticks)) -Force } catch { Die "could not move the previous $exe aside ($($_.Exception.Message)); stop the ALP processes started from it (alp daemon stop) and rerun" }
    }
    $command = Join-Path $Dir 'alp.cmd'
    $shim = "@echo off`r`nrem ALP (install.ps1): runs the installed version through $current`r`n""$current\node\node.exe"" ""$current\lib\node_modules\@anhlp\alp-cli\dist\cli.js"" %*`r`n"
    $stagedShim = Join-Path $Dir (".alp.install." + [System.Guid]::NewGuid().ToString('N') + '.cmd')
    try {
      [System.IO.File]::WriteAllText($stagedShim, $shim, (New-Object System.Text.UTF8Encoding($false)))
      Move-Item -LiteralPath $stagedShim -Destination $command -Force
    } catch {
      Remove-Item -LiteralPath $stagedShim -Force -ErrorAction SilentlyContinue
      Die "could not install $command ($($_.Exception.Message))"
    }
    Say "installed $command"
    # Older versions go; the previous one stays until the next install, for an alpd still running it.
    foreach ($old in Get-ChildItem -LiteralPath $App -Directory -Force) {
      if ($old.Name -eq 'current' -or $old.Name -eq $newVersion -or $old.Name -eq $previous) { continue }
      if ($old.Name -eq $aside -or $old.Name -eq $alpdVersion) { continue }
      if ($alpdVersion -and $old.Name -like '.alp-old-*') { continue }
      if ($old.Name -match '^[0-9]' -or $old.Name -match '^\.alp-(old|update)-') { Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # --- PATH ------------------------------------------------------------------------------------
  # HKCU\Environment Path, read unexpanded and written back with its kind (usually REG_EXPAND_SZ), so
  # entries such as %USERPROFILE%\bin keep expanding. [Environment]::SetEnvironmentVariable would
  # rewrite it as REG_SZ.
  $normal = { param($p) [Environment]::ExpandEnvironmentVariables($p).Trim().TrimEnd('\').ToLowerInvariant() }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
    $entries = @($userPath -split ';' | Where-Object { $_ })
    $onUserPath = @($entries | Where-Object { (& $normal $_) -eq (& $normal $Dir) }).Count -gt 0
    if (-not $onUserPath) {
      if ($NoModifyPath) {
        Say "$Dir is not on your user PATH; add it in Settings > System > About > Advanced system settings > Environment Variables, or rerun without -NoModifyPath"
      } else {
        $key.SetValue('Path', ((@($Dir) + $entries) -join ';'), $kind)
        # Tell running programs (Explorer, new terminals) that the environment changed.
        [Environment]::SetEnvironmentVariable('ALP_INSTALL_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('ALP_INSTALL_REFRESH', $null, 'User')
        Say "added $Dir to your user PATH; open a new terminal to use alp"
      }
    } else {
      Say "$Dir is already on your user PATH"
    }
  } finally { $key.Close() }
  if (-not (($env:Path -split ';') | Where-Object { $_ -and (& $normal $_) -eq (& $normal $Dir) })) { $env:Path = "$Dir;$env:Path" }

  & $command --version
  if ($LASTEXITCODE -ne 0) { Die "$command --version failed" }
}
