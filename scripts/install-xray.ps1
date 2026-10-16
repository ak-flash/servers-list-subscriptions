#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDir,
    [string]$ArchivePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This installer is for Windows. On Linux use scripts/install-xray.sh.'
}

$version = '26.3.27'
$architecture = $env:PROCESSOR_ARCHITEW6432
if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
switch ($architecture.ToUpperInvariant()) {
    'AMD64' {
        $asset = 'Xray-windows-64.zip'
        $checksum = 'd004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad'
    }
    'ARM64' {
        $asset = 'Xray-windows-arm64-v8a.zip'
        $checksum = '35d4ed6ec21224fb22b07c2c3f672e2350cd536f2c74d309150175a76365ea88'
    }
    'X86' {
        $asset = 'Xray-windows-32.zip'
        $checksum = '956a5ec00bce747c7936dc4ff7ac570df1c8030b0a4a8640f843488365084db3'
    }
    default { throw "Unsupported Windows architecture: $architecture" }
}

if (-not $InstallDir) {
    $InstallDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\xray'
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
$staging = Join-Path $InstallDir ('.install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
$previousProgress = $ProgressPreference
$previousTls = [Net.ServicePointManager]::SecurityProtocol

try {
    if ($ArchivePath) {
        $archive = (Resolve-Path -LiteralPath $ArchivePath -ErrorAction Stop).Path
    } else {
        $archive = Join-Path $staging $asset
        $ProgressPreference = 'SilentlyContinue'
        [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
        "Downloading Xray $version ($architecture)..."
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -MaximumRedirection 5 `
            -Uri "https://github.com/XTLS/Xray-core/releases/download/v$version/$asset" `
            -OutFile $archive
    }

    $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($archiveHash -ne $checksum) {
        throw 'Archive SHA-256 mismatch. Xray was not installed. Download the pinned official release again.'
    }

    # Extract only the verified executable; no service, TUN or public proxy is installed.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    $stagedExe = Join-Path $staging 'xray.exe'
    try {
        $entry = $zip.GetEntry('xray.exe')
        if (-not $entry) { throw 'The archive does not contain xray.exe.' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $stagedExe)
    } finally {
        $zip.Dispose()
    }

    $versionOutput = @(& $stagedExe version)
    if ($LASTEXITCODE -ne 0 -or ($versionOutput -join "`n") -notmatch ('Xray\s+' + [regex]::Escape($version) + '(?:\s|$)')) {
        throw "The downloaded executable did not report Xray $version."
    }

    $binary = Join-Path $InstallDir 'xray.exe'
    $binaryHash = (Get-FileHash -LiteralPath $stagedExe -Algorithm SHA256).Hash.ToLowerInvariant()
    $alreadyInstalled = (Test-Path -LiteralPath $binary -PathType Leaf) -and `
        ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -eq $binaryHash)
    if (-not $alreadyInstalled) {
        Copy-Item -LiteralPath $stagedExe -Destination $binary -Force
    }
    if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $binaryHash) {
        throw 'The installed executable failed SHA-256 verification.'
    }

    "Installed Xray $version`: $binary"
    'Add these settings to .env:'
    'XRAY_PATH=' + $binary.Replace('\', '/')
    "XRAY_VERSION=$version"
    "XRAY_SHA256=$binaryHash"
    'Run the local VPN tests: npm run test:vpn'
} finally {
    $ProgressPreference = $previousProgress
    [Net.ServicePointManager]::SecurityProtocol = $previousTls
    Remove-Item -LiteralPath $staging -Recurse -Force
}
