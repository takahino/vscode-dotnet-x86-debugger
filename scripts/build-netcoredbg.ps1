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
    netcoredbg のタグ（表示用）。実際に取得するのは Commit で指定したコミット。
.PARAMETER Commit
    netcoredbg のコミット。Tag が指すコミットと一致させること。
.PARAMETER RuntimeBranch
    dotnet/runtime のブランチ（表示用）。実際に取得するのは RuntimeCommit で指定したコミット。
.PARAMETER RuntimeCommit
    dotnet/runtime のコミット。netcoredbg はこのヘッダーを使ってビルドされる。
.PARAMETER Clean
    作業ディレクトリのビルド結果を削除してからビルドする。
.NOTES
    ソースはタグやブランチではなくコミットで固定する。release/10.0 はサービシングで毎月進むため、ブランチ指定だと
    リポジトリが変わらなくてもビルドのたびに中身が変わり、CI キャッシュ（キーはこのスクリプトとパッチのハッシュ）が
    切れたときに未検証のバイナリができてしまう。更新するときは、ここのコミットを書き換えて E2E テストを通すこと。
#>
[CmdletBinding()]
param(
    [string]$WorkDir = (Join-Path $env:LOCALAPPDATA 'ncdbg'),
    [string]$Tag = '3.2.0-1092',
    [string]$Commit = '9744e1f051866215611b8440c638042aa2aa2f72',
    [string]$RuntimeBranch = 'release/10.0',
    [string]$RuntimeCommit = '56d5bb652aced6bb4fed74ab43fbdd4c39b6b7ed',
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

# $Dir を $Url の $Sha の状態にする。作業ディレクトリを再利用した場合も、コミットが違えば取得し直す。
# $SparseDirs を指定すると、そのディレクトリだけをチェックアウトする（blob は必要な分だけ取得する）。
function Sync-Source([string]$Title, [string]$Dir, [string]$Url, [string]$Sha, [string[]]$SparseDirs) {
    if (Test-Path (Join-Path $Dir '.git')) {
        # 壊れたクローンでも止めずに取得し直す（stderr を Stop で例外にしない）
        $head = try { git -C $Dir rev-parse HEAD 2>$null } catch { $null }
        if ($head -eq $Sha) { return }
    } else {
        Invoke-Step "$Title の準備" { git init -q $Dir }
        Invoke-Step "$Title のリモート設定" { git -C $Dir remote add origin $Url }
    }
    # if 式の結果に入れると 1 要素の配列が文字列に戻ってしまうため、引数は配列に足していく
    $fetchArgs = @('-C', $Dir, '-c', 'core.longpaths=true', 'fetch', '--depth', '1')
    if ($SparseDirs) { $fetchArgs += '--filter=blob:none' }
    $fetchArgs += @('origin', $Sha)
    Invoke-Step "$Title の取得 ($Sha)" { git $fetchArgs }
    if ($SparseDirs) {
        Invoke-Step "$Title の sparse-checkout の設定" { git -C $Dir sparse-checkout set $SparseDirs }
    }
    Invoke-Step "$Title のチェックアウト" { git -C $Dir -c core.longpaths=true checkout -q --force --detach FETCH_HEAD }
}

Sync-Source "netcoredbg $Tag" $srcDir 'https://github.com/Samsung/netcoredbg.git' $Commit
# dotnet/runtime は巨大なため、netcoredbg のビルドに必要なディレクトリだけを取得する
Sync-Source "dotnet/runtime ($RuntimeBranch)" $runtimeDir 'https://github.com/dotnet/runtime' $RuntimeCommit @('src/coreclr', 'src/native', 'eng')

# netcoredbg への独自修正 (patches\netcoredbg\*.patch) を番号順に当てる。
# 後のパッチが前のパッチの近くを変更するため「適用済みか」の個別判定はできない。作業ディレクトリを再利用した場合も
# 毎回タグの状態に戻してから全パッチを当て直す（変更されたファイルだけが再コンパイルされる）。
Invoke-Step 'netcoredbg のソースをタグの状態に戻す' { git -C $srcDir checkout -- . }
$patches = Get-ChildItem (Join-Path $repoRoot 'patches\netcoredbg') -Filter '*.patch' -ErrorAction SilentlyContinue | Sort-Object Name
foreach ($patch in $patches) {
    Invoke-Step "パッチの適用: $($patch.Name)" { git -C $srcDir apply $patch.FullName }
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
"netcoredbg $Tag ($Commit) (x86) / runtime $RuntimeBranch ($RuntimeCommit)" | Out-File -Encoding ascii (Join-Path $destDir 'VERSION.txt')
Write-Host "配置しました: $destDir" -ForegroundColor Green
