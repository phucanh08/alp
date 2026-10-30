# Installs the ALP executable on Windows x64 (t-1e02 P2, docs/alp/binary-install.md).
#
#   irm https://github.com/phucanh08/alp/releases/latest/download/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://github.com/phucanh08/alp/releases/latest/download/install.ps1))) -Version 0.0.1-beta.5
#
# Options (or the environment variables in brackets, which also work with `| iex`):
#   -Version <v>     install release v<v> instead of the latest      [ALP_INSTALL_VERSION]
#   -Dir <path>      install alp.exe to <path>                        [ALP_INSTALL_DIR]
#                    (default %LOCALAPPDATA%\Programs\alp, else ~\.alp\bin)
#   -NoModifyPath    leave the user PATH alone and only print the step [ALP_INSTALL_NO_MODIFY_PATH=1]
#   -BaseUrl <url>   read SHA256SUMS and the archive from a mirror     [ALP_INSTALL_BASE_URL]
#                    (https://, file:// or an absolute directory)
#   -Help
#
# It downloads SHA256SUMS, takes alp-<version>-windows-x64.zip from it, checks the archive's sha256
# with Get-FileHash before extracting anything, unblocks it (Mark of the Web), installs alp.exe by
# staging beside the target and renaming, adds the directory to the user PATH once, and runs
# `alp --version`.
[CmdletBinding()]
param(
  [string]$Version = $env:ALP_INSTALL_VERSION,
  [string]$Dir = $env:ALP_INSTALL_DIR,
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
    Write-Host 'Usage: install.ps1 [-Version <v>] [-Dir <path>] [-NoModifyPath] [-BaseUrl <url or dir>]'
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

    $x = Join-Path $tmp 'x'
    Expand-Archive -LiteralPath $zip -DestinationPath $x
    $name = $asset.Substring(0, $asset.Length - '.zip'.Length)
    $binary = Join-Path $x "$name\alp.exe"
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { Die "$asset does not contain $name\alp.exe" }

    # --- install -------------------------------------------------------------------------------
    try { New-Item -ItemType Directory -Path $Dir -Force | Out-Null } catch { Die "could not create $Dir" }
    $target = Join-Path $Dir 'alp.exe'
    $aside = $null
    $staged = Join-Path $Dir (".alp.install." + [System.Guid]::NewGuid().ToString('N') + '.exe')
    try {
      Copy-Item -LiteralPath $binary -Destination $staged
      Unblock-File -LiteralPath $staged
      # Windows cannot overwrite a running .exe but can rename it: move the old one aside first.
      if (Test-Path -LiteralPath $target) {
        Get-ChildItem -LiteralPath $Dir -Filter 'alp.exe.old-*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        $aside = Join-Path $Dir ("alp.exe.old-" + [DateTime]::UtcNow.Ticks)
        Move-Item -LiteralPath $target -Destination $aside -Force
      }
      Move-Item -LiteralPath $staged -Destination $target -Force
    } catch {
      $reason = $_.Exception.Message
      Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
      # Put the previous alp.exe back if it was moved aside and the new one did not land.
      if ($aside -and -not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $aside)) {
        Move-Item -LiteralPath $aside -Destination $target -Force -ErrorAction SilentlyContinue
      }
      Die "could not install $target ($reason)"
    }
    # The licence files ride along beside alp.exe.
    foreach ($file in 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt') {
      $source = Join-Path $x "$name\$file"
      if (Test-Path -LiteralPath $source) {
        try { Copy-Item -LiteralPath $source -Destination (Join-Path $Dir $file) -Force } catch { Say "warning: could not copy $file to $Dir" }
      }
    }
    Say "installed $target"
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

  & $target --version
  if ($LASTEXITCODE -ne 0) { Die "$target --version failed" }
}
