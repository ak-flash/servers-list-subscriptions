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

$version = '26.10.21'
$architecture = $env:PROCESSOR_ARCHITEW6432
if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
switch ($architecture.ToUpperInvariant()) {
    'AMD64' {
        $asset = 'Xray-windows-64.zip'
        $checksum = 'fc58c39ee2f2717b4c54d28d374362389e5319b20ae44aea76ea45a5243ec827'
    }
    'ARM64' {
        $asset = 'Xray-windows-arm64-v8a.zip'
        $checksum = 'bb44af3380c9975f951ce7645c04d56ab600040e68f23974a2806e08e0a3f872'
    }
    'X86' {
        $asset = 'Xray-windows-32.zip'
        $checksum = '83f81c0ae86bb515c04f52e79383f4bb59c62797f17e26cb1fdccd742450c235'
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
    'Run the local VPN tests: npm run test:vpn'
} finally {
    $ProgressPreference = $previousProgress
    [Net.ServicePointManager]::SecurityProtocol = $previousTls
    Remove-Item -LiteralPath $staging -Recurse -Force
}
