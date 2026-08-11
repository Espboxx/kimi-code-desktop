[CmdletBinding()]
param(
  [ValidateSet('Verify', 'Publish')]
  [string]$Phase = 'Verify',

  [switch]$ReuseArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
  param([Parameter(Mandatory)][string]$Message)

  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-External {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  Write-Host "> $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
  }
}

function Get-ExternalOutput {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  $output = @(& $FilePath @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')`n$($output -join "`n")"
  }

  return ($output -join "`n").Trim()
}

function Assert-Toolchain {
  param([Parameter(Mandatory)][string]$RepositoryRoot)

  $expectedNode = (Get-Content -LiteralPath (Join-Path $RepositoryRoot '.nvmrc') -Raw).Trim().TrimStart('v')
  $rootManifest = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw | ConvertFrom-Json
  $expectedPnpm = ([string]$rootManifest.packageManager -split '@')[-1]
  $actualNode = (Get-ExternalOutput -FilePath 'node' -Arguments @('--version')).Trim().TrimStart('v')
  $actualPnpm = (Get-ExternalOutput -FilePath 'pnpm' -Arguments @('--version')).Trim()

  if ($actualNode -ne $expectedNode) {
    throw "Node.js $expectedNode is required, but $actualNode is active. Run: fnm use $expectedNode"
  }
  if ($actualPnpm -ne $expectedPnpm) {
    throw "pnpm $expectedPnpm is required, but $actualPnpm is active."
  }

  Write-Host "Toolchain: Node.js $actualNode, pnpm $actualPnpm"
}

function Assert-PathWithin {
  param(
    [Parameter(Mandatory)][string]$BasePath,
    [Parameter(Mandatory)][string]$TargetPath
  )

  $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
  $target = [System.IO.Path]::GetFullPath($TargetPath)
  $prefix = "$base$([System.IO.Path]::DirectorySeparatorChar)"
  if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside $base`: $target"
  }

  return $target
}

function Remove-PathWithin {
  param(
    [Parameter(Mandatory)][string]$BasePath,
    [Parameter(Mandatory)][string]$TargetPath
  )

  $safeTarget = Assert-PathWithin -BasePath $BasePath -TargetPath $TargetPath
  if (Test-Path -LiteralPath $safeTarget) {
    Remove-Item -LiteralPath $safeTarget -Recurse -Force
  }
}

function Get-WorkspaceFingerprint {
  param([Parameter(Mandatory)][string]$RepositoryRoot)

  $listedFiles = Get-ExternalOutput -FilePath 'git' -Arguments @(
    '-c',
    'core.quotePath=false',
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard'
  )
  [string[]]$relativePaths = @(
    $listedFiles -split "`r?`n" |
      Where-Object {
        $_ -and
        $_ -notlike '* TO DO list.csv' -and
        $_ -notmatch '(^|/)[.]tmp/' -and
        (Test-Path -LiteralPath (Join-Path $RepositoryRoot $_) -PathType Leaf)
      }
  )
  [System.Array]::Sort($relativePaths, [System.StringComparer]::Ordinal)

  $hash = [System.Security.Cryptography.IncrementalHash]::CreateHash(
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
  )
  $buffer = [byte[]]::new(1MB)
  try {
    foreach ($relativePath in $relativePaths) {
      $normalizedPath = $relativePath.Replace('\', '/')
      $hash.AppendData([System.Text.Encoding]::UTF8.GetBytes("$normalizedPath`0"))

      $fullPath = Join-Path $RepositoryRoot $relativePath
      $stream = [System.IO.File]::OpenRead($fullPath)
      try {
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $hash.AppendData($buffer, 0, $read)
        }
      }
      finally {
        $stream.Dispose()
      }
      $hash.AppendData([byte[]]@(0))
    }

    return [System.Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant()
  }
  finally {
    $hash.Dispose()
  }
}

function Get-SevenZipPath {
  foreach ($name in @('7z', '7za')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $command) {
      return $command.Source
    }
  }

  if ($env:LOCALAPPDATA) {
    $cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
    if (Test-Path -LiteralPath $cache) {
      $candidate = Get-ChildItem -LiteralPath $cache -Recurse -Filter '7za.exe' -File -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTimeUtc -Descending |
        Select-Object -First 1
      if ($null -ne $candidate) {
        return $candidate.FullName
      }
    }
  }

  throw '7-Zip was not found in PATH or the electron-builder cache.'
}

function Assert-PackagedLicenses {
  param(
    [Parameter(Mandatory)][string]$ReleaseDirectory,
    [Parameter(Mandatory)][string]$ArtifactPath
  )

  $unpackedDirectory = Join-Path $ReleaseDirectory 'win-unpacked'
  $unpackedLicenses = @(
    (Join-Path $unpackedDirectory 'resources\LICENSE'),
    (Join-Path $unpackedDirectory 'resources\THIRD_PARTY_NOTICES.md'),
    (Join-Path $unpackedDirectory 'LICENSE.electron.txt'),
    (Join-Path $unpackedDirectory 'LICENSES.chromium.html')
  )
  foreach ($licensePath in $unpackedLicenses) {
    if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
      throw "Packaged license file is missing: $licensePath"
    }
  }
  $nativeFiles = @(
    (Join-Path $unpackedDirectory 'resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\conpty.node'),
    (Join-Path $unpackedDirectory 'resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\pty.node')
  )
  foreach ($nativeFile in $nativeFiles) {
    if (-not (Test-Path -LiteralPath $nativeFile -PathType Leaf)) {
      throw "Packaged native file is missing: $nativeFile"
    }
  }

  $sevenZip = Get-SevenZipPath
  $listing = Get-ExternalOutput -FilePath $sevenZip -Arguments @('l', $ArtifactPath)
  foreach ($entry in @(
    'resources\LICENSE',
    'resources\THIRD_PARTY_NOTICES.md',
    'resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\pty.node',
    'LICENSE.electron.txt',
    'LICENSES.chromium.html'
  )) {
    if (-not $listing.Contains($entry, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Portable executable does not contain $entry"
    }
  }

  Write-Host 'Packaged licenses and Windows x64 native dependencies verified'
}

function Write-ArtifactChecksum {
  param([Parameter(Mandatory)][string]$ArtifactPath)

  $checksumPath = "$ArtifactPath.sha256"
  $hash = (Get-FileHash -LiteralPath $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $line = "$hash  $([System.IO.Path]::GetFileName($ArtifactPath))`n"
  [System.IO.File]::WriteAllText($checksumPath, $line, [System.Text.Encoding]::ASCII)
  Write-Host "SHA256: $hash"

  return [pscustomobject]@{
    Hash = $hash
    Path = $checksumPath
  }
}

function Invoke-DesktopVerification {
  param(
    [Parameter(Mandatory)][string]$ReleaseDirectory,
    [Parameter(Mandatory)][string]$ArtifactPath
  )

  Write-Step 'Install frozen dependencies'
  Invoke-External -FilePath 'pnpm' -Arguments @('install', '--frozen-lockfile')

  Write-Step 'Run Desktop unit tests'
  Invoke-External -FilePath 'pnpm' -Arguments @('--filter', '@moonshot-ai/kimi-code-desktop', 'test')

  Write-Step 'Run Desktop typecheck'
  Invoke-External -FilePath 'pnpm' -Arguments @('--filter', '@moonshot-ai/kimi-code-desktop', 'typecheck')

  Write-Step 'Check third-party notices'
  Invoke-External -FilePath 'pnpm' -Arguments @('--filter', '@moonshot-ai/kimi-code-desktop', 'licenses:check')

  Write-Step 'Build Desktop'
  Invoke-External -FilePath 'pnpm' -Arguments @('--filter', '@moonshot-ai/kimi-code-desktop', 'build')

  Write-Step 'Run Desktop Electron E2E'
  Invoke-External -FilePath 'pnpm' -Arguments @('--filter', '@moonshot-ai/kimi-code-desktop', 'e2e')

  Write-Step 'Build clean Windows x64 portable package'
  Remove-PathWithin -BasePath $ReleaseDirectory -TargetPath (Join-Path $ReleaseDirectory 'win-unpacked')
  Remove-PathWithin -BasePath $ReleaseDirectory -TargetPath $ArtifactPath
  Remove-PathWithin -BasePath $ReleaseDirectory -TargetPath "$ArtifactPath.sha256"

  $previousCertificateSetting = $env:CSC_IDENTITY_AUTO_DISCOVERY
  try {
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    Invoke-External -FilePath 'pnpm' -Arguments @(
      '--filter',
      '@moonshot-ai/kimi-code-desktop',
      'exec',
      'electron-builder',
      '--win',
      'portable',
      '--x64'
    )

    Write-Step 'Inspect and smoke packaged Windows application'
    Invoke-External -FilePath 'node' -Arguments @(
      'apps/desktop/scripts/inspect-packaged-app.mjs',
      'windows-x64'
    )
    Invoke-External -FilePath 'node' -Arguments @(
      'apps/desktop/scripts/smoke-packaged-app.mjs',
      'windows-x64'
    )
  }
  finally {
    if ($null -eq $previousCertificateSetting) {
      Remove-Item Env:CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue
    }
    else {
      $env:CSC_IDENTITY_AUTO_DISCOVERY = $previousCertificateSetting
    }
  }
}

function Assert-ReusableArtifact {
  param(
    [Parameter(Mandatory)][string]$BuildStampPath,
    [Parameter(Mandatory)][string]$WorkspaceFingerprint
  )

  if (-not (Test-Path -LiteralPath $BuildStampPath -PathType Leaf)) {
    throw "No verified build stamp exists at $BuildStampPath. Run without -ReuseArtifacts first."
  }
  $recordedFingerprint = (Get-Content -LiteralPath $BuildStampPath -Raw).Trim()
  if ($recordedFingerprint -ne $WorkspaceFingerprint) {
    throw 'The workspace changed after the verified build. Run without -ReuseArtifacts.'
  }

  Write-Step 'Reuse artifacts from the matching verified workspace'
  Invoke-External -FilePath 'pnpm' -Arguments @('--filter', '@moonshot-ai/kimi-code-desktop', 'licenses:check')
}

function Assert-CleanMainBranch {
  $branch = Get-ExternalOutput -FilePath 'git' -Arguments @('branch', '--show-current')
  if ($branch -ne 'main') {
    throw "Desktop releases must be published from main, not $branch."
  }

  $status = Get-ExternalOutput -FilePath 'git' -Arguments @('status', '--porcelain')
  if ($status) {
    throw "Publish requires a clean worktree:`n$status"
  }
}

function Get-RemoteTagCommit {
  param([Parameter(Mandatory)][string]$Tag)

  $lines = Get-ExternalOutput -FilePath 'git' -Arguments @(
    'ls-remote',
    '--tags',
    'origin',
    "refs/tags/$Tag",
    "refs/tags/$Tag^{}"
  )
  if (-not $lines) {
    return $null
  }

  $peeledLine = @($lines -split "`r?`n" | Where-Object { $_ -like "*refs/tags/$Tag^{}" }) | Select-Object -First 1
  $selectedLine = if ($peeledLine) { $peeledLine } else { @($lines -split "`r?`n")[0] }
  return @($selectedLine -split '\s+')[0]
}

function Push-ReleaseTag {
  param(
    [Parameter(Mandatory)][string]$Tag,
    [Parameter(Mandatory)][string]$HeadCommit
  )

  $localTag = Get-ExternalOutput -FilePath 'git' -Arguments @('tag', '--list', $Tag)
  if ($localTag) {
    $localCommit = Get-ExternalOutput -FilePath 'git' -Arguments @('rev-list', '-n', '1', $Tag)
    if ($localCommit -ne $HeadCommit) {
      throw "Local tag $Tag points to $localCommit instead of $HeadCommit."
    }
  }

  $remoteCommit = Get-RemoteTagCommit -Tag $Tag
  if ($remoteCommit) {
    if ($remoteCommit -ne $HeadCommit) {
      throw "Remote tag $Tag points to $remoteCommit instead of $HeadCommit."
    }
    Write-Host "Remote tag $Tag already points to $HeadCommit"
    return
  }

  if (-not $localTag) {
    Invoke-External -FilePath 'git' -Arguments @('tag', $Tag)
  }
  Invoke-External -FilePath 'git' -Arguments @('push', 'origin', "refs/tags/$Tag")
}

function Get-OriginRepository {
  $originUrl = Get-ExternalOutput -FilePath 'git' -Arguments @('remote', 'get-url', 'origin')
  $json = Get-ExternalOutput -FilePath 'gh' -Arguments @(
    'repo',
    'view',
    $originUrl,
    '--json',
    'nameWithOwner,url'
  )
  $repository = $json | ConvertFrom-Json
  if (-not $repository.nameWithOwner) {
    throw "Could not resolve the GitHub repository for origin: $originUrl"
  }

  Write-Host "GitHub repository: $($repository.nameWithOwner) ($($repository.url))"
  return [string]$repository.nameWithOwner
}

function Wait-DesktopReleaseRun {
  param(
    [Parameter(Mandatory)][string]$Tag,
    [Parameter(Mandatory)][string]$HeadCommit,
    [Parameter(Mandatory)][string]$GitHubRepository
  )

  Write-Step "Wait for GitHub Actions run for $Tag"
  $deadline = [System.DateTime]::UtcNow.AddMinutes(3)
  $run = $null
  do {
    $json = Get-ExternalOutput -FilePath 'gh' -Arguments @(
      'run',
      'list',
      '--workflow',
      'desktop-release.yml',
      '--branch',
      $Tag,
      '--event',
      'push',
      '--repo',
      $GitHubRepository,
      '--limit',
      '20',
      '--json',
      'databaseId,headSha,status,conclusion,url'
    )
    $runs = if ($json) { @($json | ConvertFrom-Json) } else { @() }
    $run = $runs | Where-Object { $_.headSha -eq $HeadCommit } | Select-Object -First 1
    if ($null -eq $run) {
      Start-Sleep -Seconds 3
    }
  } while ($null -eq $run -and [System.DateTime]::UtcNow -lt $deadline)

  if ($null -eq $run) {
    throw "No Desktop Release workflow run appeared for $Tag at $HeadCommit."
  }

  Write-Host "Workflow: $($run.url)"
  Invoke-External -FilePath 'gh' -Arguments @(
    'run',
    'watch',
    [string]$run.databaseId,
    '--repo',
    $GitHubRepository,
    '--exit-status'
  )
  return $run
}

function Assert-GitHubRelease {
  param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$Tag,
    [Parameter(Mandatory)][string[]]$ArtifactNames,
    [Parameter(Mandatory)][string]$GitHubRepository
  )

  Write-Step "Verify GitHub Release $Tag"
  $releaseJson = Get-ExternalOutput -FilePath 'gh' -Arguments @(
    'release',
    'view',
    $Tag,
    '--repo',
    $GitHubRepository,
    '--json',
    'url,assets'
  )
  $release = $releaseJson | ConvertFrom-Json
  [string[]]$assetNames = @($release.assets | ForEach-Object { [string]$_.name })
  [string[]]$expectedAssets = @($ArtifactNames | ForEach-Object { $_; "$_.sha256" })
  foreach ($expectedAsset in $expectedAssets) {
    if ($assetNames -notcontains $expectedAsset) {
      throw "GitHub Release $Tag is missing $expectedAsset."
    }
  }

  $downloadBase = Join-Path $RepositoryRoot '.tmp\desktop-release'
  $downloadDirectory = Join-Path $downloadBase $Tag
  $safeDownloadDirectory = Assert-PathWithin -BasePath $downloadBase -TargetPath $downloadDirectory
  Remove-PathWithin -BasePath $downloadBase -TargetPath $safeDownloadDirectory
  New-Item -ItemType Directory -Path $safeDownloadDirectory -Force | Out-Null
  [string[]]$downloadArguments = @(
    'release',
    'download',
    $Tag,
    '--repo',
    $GitHubRepository,
    '--dir',
    $safeDownloadDirectory
  )
  foreach ($expectedAsset in $expectedAssets) {
    $downloadArguments += @('--pattern', $expectedAsset)
  }
  Invoke-External -FilePath 'gh' -Arguments $downloadArguments
  Invoke-External -FilePath 'node' -Arguments @(
    'apps/desktop/scripts/release-artifacts.mjs',
    'verify',
    $safeDownloadDirectory
  )

  Write-Host "Release: $($release.url)"
  Write-Host "Published assets: $($expectedAssets -join ', ')"
  return [pscustomobject]@{
    Url = [string]$release.url
    DownloadDirectory = $safeDownloadDirectory
  }
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$desktopDirectory = Join-Path $repositoryRoot 'apps\desktop'
$releaseDirectory = Join-Path $desktopDirectory 'release'
$manifestPath = Join-Path $desktopDirectory 'package.json'

Push-Location $repositoryRoot
try {
  Write-Step 'Validate release metadata and toolchain'
  Assert-Toolchain -RepositoryRoot $repositoryRoot

  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $version = [string]$manifest.version
  if (-not $version) {
    throw 'apps/desktop/package.json has no version.'
  }
  $tag = "desktop-v$version"
  $artifactName = "Kimi-Code-Desktop-$version-x64-portable.exe"
  [string[]]$releaseArtifactNames = @(
    $artifactName,
    "Kimi-Code-Desktop-$version-arm64.dmg",
    "Kimi-Code-Desktop-$version-x64.AppImage",
    "Kimi-Code-Desktop-$version-x64.deb"
  )
  $artifactPath = Join-Path $releaseDirectory $artifactName
  $buildStampPath = Join-Path $releaseDirectory '.verified-workspace.sha256'
  Invoke-External -FilePath 'node' -Arguments @('apps/desktop/scripts/check-release-tag.mjs', $tag)

  $workspaceFingerprint = Get-WorkspaceFingerprint -RepositoryRoot $repositoryRoot
  if ($ReuseArtifacts) {
    Assert-ReusableArtifact -BuildStampPath $buildStampPath -WorkspaceFingerprint $workspaceFingerprint
  }
  else {
    Invoke-DesktopVerification -ReleaseDirectory $releaseDirectory -ArtifactPath $artifactPath
    $fingerprintAfterBuild = Get-WorkspaceFingerprint -RepositoryRoot $repositoryRoot
    if ($fingerprintAfterBuild -ne $workspaceFingerprint) {
      throw 'Tracked or untracked source files changed during verification; rerun the script.'
    }
    [System.IO.File]::WriteAllText($buildStampPath, "$workspaceFingerprint`n", [System.Text.Encoding]::ASCII)
  }

  if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
    throw "Portable artifact is missing: $artifactPath"
  }
  Assert-PackagedLicenses -ReleaseDirectory $releaseDirectory -ArtifactPath $artifactPath
  $checksum = Write-ArtifactChecksum -ArtifactPath $artifactPath

  $releaseResult = $null
  if ($Phase -eq 'Publish') {
    Write-Step 'Publish main and release tag'
    Assert-CleanMainBranch
    Invoke-External -FilePath 'gh' -Arguments @('auth', 'status')
    $gitHubRepository = Get-OriginRepository
    Invoke-External -FilePath 'git' -Arguments @('push', 'origin', 'main')
    $headCommit = Get-ExternalOutput -FilePath 'git' -Arguments @('rev-parse', 'HEAD')
    Push-ReleaseTag -Tag $tag -HeadCommit $headCommit
    Wait-DesktopReleaseRun -Tag $tag -HeadCommit $headCommit -GitHubRepository $gitHubRepository | Out-Null
    $releaseResult = Assert-GitHubRelease `
      -RepositoryRoot $repositoryRoot `
      -Tag $tag `
      -ArtifactNames $releaseArtifactNames `
      -GitHubRepository $gitHubRepository
  }

  Write-Host "`nDesktop release $Phase completed." -ForegroundColor Green
  Write-Host "Tag: $tag"
  Write-Host "Artifact: $artifactPath"
  Write-Host "Checksum: $($checksum.Path)"
  if ($null -ne $releaseResult) {
    Write-Host "GitHub Release: $($releaseResult.Url)"
  }
}
finally {
  Pop-Location
}
