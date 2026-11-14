<#
.SYNOPSIS
    netcoredbg を x86 (Win32) 向けにソースビルドし、debugger\netcoredbg-x86 に配置する。
.DESCRIPTION
    必要なもの: Visual Studio 2022 以降（「C++ によるデスクトップ開発」ワークロード。CMake も同梱のものを使う）、
    Git、.NET SDK（ManagedPart のビルドに使用）。
.PARAMETER WorkDir
    ソース取得とビルドの作業ディレクトリ。dotnet/runtime のソースはパスが深く MAX_PATH (260) を超えやすいため、
    短いパスを指定すること。
.PARAMETER Tag
    netcoredbg のタグ。
.PARAMETER Clean
    作業ディレクトリのビルド結果を削除してからビルドする。
#>
[CmdletBinding()]
param(
    [string]$WorkDir = (Join-Path $env:LOCALAPPDATA 'ncdbg'),
    [string]$Tag = '3.2.0-1092',
    [string]$RuntimeBranch = 'release/10.0',
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $repoRoot 'debugger\netcoredbg-x86'

# ネイティブコマンドは失敗しても例外にならないため、終了コードで判定する
function Invoke-Step([string]$Title, [scriptblock]$Command) {
    Write-Host "==> $Title" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Title に失敗しました (exit code $LASTEXITCODE)。上のログを確認してください。"
    }
}

function Find-VisualStudio {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) {
        throw 'vswhere.exe が見つかりません。Visual Studio 2022 以降をインストールしてください。'
    }
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json | ConvertFrom-Json
    if (-not $vs) {
        throw 'C++ ツールを含む Visual Studio が見つかりません。「C++ によるデスクトップ開発」ワークロードを追加してください。'
    }
    return @($vs)[0]
}

function Get-CMakeGenerator($vs) {
    $major = [int]($vs.installationVersion.Split('.')[0])
    switch ($major) {
        17 { return 'Visual Studio 17 2022' }
        18 { return 'Visual Studio 18 2026' }
        default { throw "未対応の Visual Studio バージョンです: $($vs.installationVersion)" }
    }
}

if ($WorkDir.Length -gt 40) {
    Write-Warning "WorkDir が長いパスです ($($WorkDir.Length) 文字)。MAX_PATH 超過でビルドが失敗する場合は短いパスを指定してください。"
}
foreach ($cmd in 'git', 'dotnet') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd が見つかりません。インストールして PATH を通してください。" }
}

$vs = Find-VisualStudio
$cmake = Join-Path $vs.installationPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path $cmake)) {
    $cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
    if (-not $cmake) { throw 'CMake が見つかりません。Visual Studio の「Windows 用 C++ CMake ツール」を追加してください。' }
}
$generator = Get-CMakeGenerator $vs
$dotnetDir = Split-Path -Parent (Get-Command dotnet).Source

$srcDir = Join-Path $WorkDir 'netcoredbg'
$runtimeDir = Join-Path $WorkDir 'runtime'
$buildDir = Join-Path $WorkDir 'build'
$installDir = Join-Path $WorkDir 'install'
New-Item -ItemType Directory -Force $WorkDir | Out-Null

if (-not (Test-Path $srcDir)) {
    Invoke-Step "netcoredbg $Tag の取得" { git clone --depth 1 -b $Tag https://github.com/Samsung/netcoredbg.git $srcDir }
}
if (-not (Test-Path $runtimeDir)) {
    # dotnet/runtime は巨大なため、netcoredbg のビルドに必要なディレクトリだけを取得する
    Invoke-Step "dotnet/runtime ($RuntimeBranch) の取得" {
        git -c core.longpaths=true clone --depth 1 --filter=blob:none --sparse -b $RuntimeBranch https://github.com/dotnet/runtime $runtimeDir
    }
    Invoke-Step 'sparse-checkout の設定' { git -C $runtimeDir sparse-checkout set src/coreclr src/native eng }
}

if ($Clean) {
    Remove-Item -Recurse -Force $buildDir, $installDir -ErrorAction SilentlyContinue
}

Invoke-Step 'CMake 構成 (Win32)' {
    & $cmake -S $srcDir -B $buildDir -G $generator -A Win32 -DCLR_CMAKE_HOST_ARCH=x86 `
        "-DCORECLR_DIR=$runtimeDir\src\coreclr" "-DDOTNET_DIR=$dotnetDir" "-DCMAKE_INSTALL_PREFIX=$installDir"
}
Invoke-Step 'ビルド' { & $cmake --build $buildDir --config Release --target install -- '/m' '/v:m' }

$exe = Join-Path $installDir 'netcoredbg.exe'
if (-not (Test-Path $exe)) { throw "ビルド後に netcoredbg.exe が見つかりません: $exe" }

if (Test-Path $destDir) { Remove-Item -Recurse -Force $destDir }
New-Item -ItemType Directory -Force $destDir | Out-Null
Copy-Item (Join-Path $installDir '*') $destDir -Recurse
Copy-Item (Join-Path $srcDir 'LICENSE') (Join-Path $destDir 'LICENSE.netcoredbg.txt')
"netcoredbg $Tag (x86) / runtime $RuntimeBranch" | Out-File -Encoding ascii (Join-Path $destDir 'VERSION.txt')
Write-Host "配置しました: $destDir" -ForegroundColor Green
