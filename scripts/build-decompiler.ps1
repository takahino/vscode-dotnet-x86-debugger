<#
.SYNOPSIS
    逆コンパイル ヘルパー (tools\Decompiler) をビルドし、debugger\decompiler に配置する。
.DESCRIPTION
    必要なもの: .NET SDK 8 以降。ICSharpCode.Decompiler を NuGet から取得する。
    framework-dependent（.NET 8 以降で動作）なので、実行時に必要なのは .NET ランタイムだけ。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot 'tools\Decompiler\Decompiler.csproj'
$destDir = Join-Path $repoRoot 'debugger\decompiler'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'dotnet が見つかりません。.NET SDK 8 以降をインストールして PATH を通してください。'
}

# 古いファイルが残らないよう、配置先を作り直す
if (Test-Path $destDir) { Remove-Item -Recurse -Force $destDir }
Write-Host '==> 逆コンパイル ヘルパーのビルド' -ForegroundColor Cyan
& dotnet publish $project -c Release -o $destDir -nologo -v q
if ($LASTEXITCODE -ne 0) {
    throw "逆コンパイル ヘルパーのビルドに失敗しました (exit code $LASTEXITCODE)。上のログを確認してください。"
}
Write-Host "配置しました: $destDir" -ForegroundColor Green
