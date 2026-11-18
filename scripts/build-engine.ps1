<#
.SYNOPSIS
    デバッグエンジン dotnet-x86dbg (Rust) をビルドし、debugger\dotnet-x86dbg-x86 に配置する。
.DESCRIPTION
    dotnet-x86dbg のリポジトリの build.ps1 を呼び、x86 の dist (dotnet-x86dbg.exe と dbgshim.dll) を写す。
    必要なもの: Rust (rustup。ターゲット i686-pc-windows-msvc / x86_64-pc-windows-msvc)、Visual Studio の C++ ビルドツール。
    エンジン自身は .NET のランタイムを使わない (.NET Framework のアプリも、.NET 無しでデバッグできる)。
.PARAMETER EngineRepo
    dotnet-x86dbg のリポジトリ。既定は、この拡張のリポジトリと並んだ ..\dotnet-x86dbg。
.PARAMETER SkipBuild
    ビルドせず、すでにある dist\x86 を写すだけにする。
#>
[CmdletBinding()]
param(
    [string]$EngineRepo = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'dotnet-x86dbg'),
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $repoRoot 'debugger\dotnet-x86dbg-x86'

if (-not (Test-Path (Join-Path $EngineRepo 'Cargo.toml'))) {
    throw "dotnet-x86dbg のリポジトリが見つかりません: $EngineRepo 。-EngineRepo で場所を指定してください。"
}
if (-not $SkipBuild) {
    & (Join-Path $EngineRepo 'build.ps1')
    if (-not $?) { throw 'dotnet-x86dbg のビルドに失敗しました。上の出力を確認してください。' }
}
$dist = Join-Path $EngineRepo 'dist\x86'
$files = 'dotnet-x86dbg.exe', 'dbgshim.dll'
foreach ($f in $files) {
    if (-not (Test-Path (Join-Path $dist $f))) {
        throw "$f が $dist にありません。-SkipBuild を外してビルドしてください。"
    }
}
New-Item -ItemType Directory -Force $destDir | Out-Null
foreach ($f in $files) {
    Copy-Item (Join-Path $dist $f) $destDir -Force
}
Write-Host "配置しました: $destDir"