<#
.SYNOPSIS
    デバッグエンジン netdbg を GitHub Releases から取得し、debugger\netdbg-x86 と debugger\netdbg-x64 に配置する。
.DESCRIPTION
    ローカルで Rust ビルドする代わりに、netdbg のリリース ZIP (win-x86 / win-x64) をダウンロードします。
    版は scripts\engine-release.version（CI の ENGINE_REF と対応するリリースに合わせて更新）が既定です。
.PARAMETER Version
    取得する netdbg の版（例: 0.9.0）。省略時は engine-release.version。
.PARAMETER Repository
    GitHub の owner/repo。既定は takahino/netdbg。
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Repository = 'takahino/netdbg'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $PSScriptRoot 'engine-release.version'

if (-not $Version) {
    if (-not (Test-Path $versionFile)) {
        throw "engine-release.version がありません: $versionFile"
    }
    $Version = (Get-Content $versionFile -Raw).Trim()
}
if (-not $Version) {
    throw 'netdbg の版が空です。engine-release.version を書くか、-Version を指定してください。'
}

$tag = if ($Version -match '^v') { $Version } else { "v$Version" }
$bare = $tag -replace '^v', ''
$owner, $repo = $Repository -split '/', 2
if (-not $repo) {
    throw "Repository は owner/name 形式にしてください: $Repository"
}

$required = @('netdbg.exe', 'dbgshim.dll', 'encdelta\EncDelta.dll')
foreach ($arch in 'x86', 'x64') {
    $asset = "netdbg-$bare-win-$arch.zip"
    $url = "https://github.com/$owner/$repo/releases/download/$tag/$asset"
    $destDir = Join-Path $repoRoot "debugger\netdbg-$arch"
    $work = Join-Path ([System.IO.Path]::GetTempPath()) "netdbg-fetch-$bare-$arch"
    if (Test-Path $work) {
        Remove-Item -Recurse -Force $work
    }
    New-Item -ItemType Directory -Force $work | Out-Null
    $zip = Join-Path $work $asset
    Write-Host "==> ダウンロード: $url" -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    } catch {
        throw "netdbg $tag ($arch) の取得に失敗しました: $url`n$($_.Exception.Message)"
    }
    $extract = Join-Path $work 'extract'
    New-Item -ItemType Directory -Force $extract | Out-Null
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    foreach ($f in $required) {
        if (-not (Test-Path (Join-Path $extract $f))) {
            throw "$asset に $f がありません。リリースのレイアウトが変わっていないか確認してください。"
        }
    }
    New-Item -ItemType Directory -Force $destDir | Out-Null
    Copy-Item (Join-Path $extract 'netdbg.exe') $destDir -Force
    Copy-Item (Join-Path $extract 'dbgshim.dll') $destDir -Force
    $encdelta = Join-Path $destDir 'encdelta'
    if (Test-Path $encdelta) {
        Remove-Item -Recurse -Force $encdelta
    }
    Copy-Item (Join-Path $extract 'encdelta') $encdelta -Recurse -Force
    Write-Host "配置しました: $destDir (netdbg $tag)" -ForegroundColor Green
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}