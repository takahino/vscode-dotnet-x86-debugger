# 開発に参加する

## ソースからのビルド

前提: Node.js、Git、.NET SDK、Visual Studio 2022 以降（「C++ によるデスクトップ開発」ワークロード）。

```powershell
# netcoredbg を x86 向けにビルド（debugger\netcoredbg-x86 に配置）し、コンパイル・VSIX 作成・VS Code へのインストールまで行う
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# VSIX の作成のみ（out\dotnet-x86-debugger.vsix）
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipInstall
```

`scripts\build-netcoredbg.ps1` は、Windows の `MAX_PATH` 制限に収まるよう、netcoredbg と `dotnet/runtime` の必要な部分だけを、それぞれコミットを固定して
短い作業ディレクトリ（既定は `%LOCALAPPDATA%\ncdbg`）に取得してビルドします。
netcoredbg への独自修正は [`patches/netcoredbg`](patches/netcoredbg) にあり、ビルド時に自動で適用されます。
netcoredbg や runtime を新しくするときは、スクリプト冒頭の `-Commit` / `-RuntimeCommit`（と `-Tag` / `-RuntimeBranch`）を書き換えて
E2E テストを実行します。CI のキャッシュ キーはスクリプトのハッシュを含むため、CI でもビルドし直してテストされます。

拡張機能自体をデバッグするには、このフォルダを VS Code で開き **Run Extension**（F5）を実行します。

### テスト

```powershell
npm test          # デバッガーを使わないロジックの単体テスト（高速）
npm run test:e2e  # E2E テスト: 本物の netcoredbg で test\apps のアプリをデバッグする
```

E2E テストには、同梱用の netcoredbg（`scripts\build-netcoredbg.ps1`）、逆コンパイル ヘルパー（`scripts\build-decompiler.ps1`）、
.NET SDK、x86 版 .NET（Desktop）ランタイムが必要です。停止する行はテスト アプリの `// @名前` マーカーで探します。
デスクトップの無い環境では `DOTNETX86_SKIP_UI_TESTS=1` で WinForms のテストを飛ばせます。
[CI ワークフロー](.github/workflows/ci.yml) が push のたびに両方を実行します。

## リリース手順

1. `package.json` の `version` と `CHANGELOG.md` を更新してコミットします。
2. version と一致するタグを push します。

   ```powershell
   git tag v0.1.0
   git push origin v0.1.0
   ```

[Release ワークフロー](.github/workflows/release.yml)が netcoredbg (x86) のビルド・VSIX の作成を行い、
`dotnet-x86-debugger-<version>.vsix` と `install-vsix.ps1` を添付した GitHub Release を作成します。
手動実行（*workflow_dispatch*）の場合は、ファイルをビルド成果物 (artifact) としてアップロードするだけです。
