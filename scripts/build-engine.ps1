<#
.SYNOPSIS
    デバッグエンジン netdbg (Rust) をビルドし、debugger\netdbg-x86 と debugger\netdbg-x64 に配置する。
.DESCRIPTION
    netdbg のリポジトリの build.ps1 を呼び、dist の x86 と x64 (netdbg.exe と dbgshim.dll、Edit and Continue の
    差分を作る補助の encdelta フォルダー) を写す。
    ICorDebug は、デバッガーと対象のビット数が同じでなければ動かないので、拡張は対象に合う方を起動する。
    必要なもの: Rust (rustup。ターゲット i686-pc-windows-msvc / x86_64-pc-windows-msvc)、Visual Studio の C++ ビルドツール。
    エンジン自身は .NET のランタイムを使わない (.NET Framework のアプリも、.NET 無しでデバッグできる)。
.PARAMETER EngineRepo
    netdbg のリポジトリ。既定は、この拡張のリポジトリと並んだ ..\dotnet-x86dbg。
.PARAMETER SkipBuild
    ビルドせず、すでにある dist を写すだけにする。
#>
[CmdletBinding()]
param(
    [string]$EngineRepo = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'dotnet-x86dbg'),
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path (Join-Path $EngineRepo 'Cargo.toml'))) {
    throw "netdbg のリポジトリが見つかりません: $EngineRepo 。-EngineRepo で場所を指定してください。"
}
if (-not $SkipBuild) {
    & (Join-Path $EngineRepo 'build.ps1')
    if (-not $?) { throw 'netdbg のビルドに失敗しました。上の出力を確認してください。' }
}
$files = 'netdbg.exe', 'dbgshim.dll'
foreach ($arch in 'x86', 'x64') {
    $dist = Join-Path $EngineRepo "dist\$arch"
    foreach ($f in $files + 'encdelta\EncDelta.dll') {
        if (-not (Test-Path (Join-Path $dist $f))) {
            throw "$f が $dist にありません。-SkipBuild を外してビルドしてください。"
        }
    }
}
foreach ($arch in 'x86', 'x64') {
    $destDir = Join-Path $repoRoot "debugger\netdbg-$arch"
    New-Item -ItemType Directory -Force $destDir | Out-Null
    foreach ($f in $files) {
        Copy-Item (Join-Path $EngineRepo "dist\$arch\$f") $destDir -Force
    }
    # Edit and Continue の補助 (C#。動くときに、利用者の .NET SDK の Roslyn を読み込む)。
    $encdelta = Join-Path $destDir 'encdelta'
    if (Test-Path $encdelta) { Remove-Item -Recurse -Force $encdelta }
    Copy-Item (Join-Path $EngineRepo "dist\$arch\encdelta") $encdelta -Recurse -Force
    Write-Host "配置しました: $destDir"
}