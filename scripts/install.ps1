<#
.SYNOPSIS
    拡張機能をビルドして VSIX を作成し、VS Code にインストールする。
.PARAMETER SkipInstall
    VSIX の作成のみ行い、インストールしない。
.PARAMETER CodePath
    code コマンド（code.cmd）のパス。省略時は PATH と既定のインストール先から探す。
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [string]$CodePath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$vsixPath = Join-Path $repoRoot 'out\dotnet-x86-debugger.vsix'

# ネイティブコマンドは失敗しても例外にならないため、終了コードで判定する
function Invoke-Step([string]$Title, [scriptblock]$Command) {
    Write-Host "==> $Title" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Title に失敗しました (exit code $LASTEXITCODE)。上のログを確認してください。"
    }
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'npm が見つかりません。Node.js をインストールして PATH を通してください。'
}

Push-Location $repoRoot
try {
    # VSIX に同梱する x86 版 netcoredbg が未ビルドならビルドする
    if (-not (Test-Path (Join-Path $repoRoot 'debugger\netcoredbg-x86\netcoredbg.exe'))) {
        & (Join-Path $PSScriptRoot 'build-netcoredbg.ps1')
    }
    # VSIX に同梱する逆コンパイル ヘルパーが未ビルドならビルドする
    if (-not (Test-Path (Join-Path $repoRoot 'debugger\decompiler\DotnetX86.Decompiler.dll'))) {
        & (Join-Path $PSScriptRoot 'build-decompiler.ps1')
    }
    if (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
        Invoke-Step '依存関係のインストール (npm ci)' { npm.cmd ci --no-fund --no-audit }
    }
    # 削除したソースの古い .js が VSIX に混入しないよう、出力先を毎回作り直す
    $outDir = Join-Path $repoRoot 'out'
    if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
    Invoke-Step 'TypeScript のコンパイル' { npm.cmd run compile }
    Invoke-Step 'VSIX の作成' { npm.cmd run package }
    Write-Host "VSIX を作成しました: $vsixPath" -ForegroundColor Green

    if ($SkipInstall) { return }

    $installArgs = @{ VsixPath = $vsixPath }
    if ($CodePath) { $installArgs.CodePath = $CodePath }
    & (Join-Path $PSScriptRoot 'install-vsix.ps1') @installArgs
}
finally {
    Pop-Location
}
