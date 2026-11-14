<#
.SYNOPSIS
    .NET x86 Debugger の VSIX を VS Code にインストールする。
.DESCRIPTION
    GitHub Releases からダウンロードした VSIX と同じフォルダに置いて実行する。
    -VsixPath を省略すると、このスクリプトと同じフォルダにある最新の dotnet-x86-debugger*.vsix を使う。
.PARAMETER VsixPath
    インストールする VSIX のパス。
.PARAMETER CodePath
    code コマンド（code.cmd）のパス。省略時は PATH と既定のインストール先から探す。
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install-vsix.ps1
#>
[CmdletBinding()]
param(
    [string]$VsixPath,
    [string]$CodePath
)

$ErrorActionPreference = 'Stop'

function Find-Vsix {
    if ($VsixPath) {
        if (-not (Test-Path $VsixPath)) { throw "指定された VSIX が見つかりません: $VsixPath" }
        return (Resolve-Path $VsixPath).Path
    }
    $found = Get-ChildItem -Path $PSScriptRoot -Filter 'dotnet-x86-debugger*.vsix' -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $found) {
        throw "VSIX が見つかりません。このスクリプトと同じフォルダ ($PSScriptRoot) に dotnet-x86-debugger の .vsix を置くか、-VsixPath で指定してください。"
    }
    return $found.FullName
}

function Find-Code {
    if ($CodePath) {
        if (-not (Test-Path $CodePath)) { throw "指定された CodePath が見つかりません: $CodePath" }
        return $CodePath
    }
    $cmd = Get-Command code.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
        (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd')
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    throw 'VS Code の code コマンドが見つかりません。-CodePath で code.cmd のパスを指定してください。'
}

$vsix = Find-Vsix
$code = Find-Code
Write-Host "==> VS Code へのインストール: $vsix" -ForegroundColor Cyan
& $code --install-extension $vsix --force
if ($LASTEXITCODE -ne 0) {
    throw "VS Code へのインストールに失敗しました (exit code $LASTEXITCODE)。上のログを確認してください。"
}
Write-Host 'インストールが完了しました。VS Code を再読み込み（Developer: Reload Window）してください。' -ForegroundColor Green
