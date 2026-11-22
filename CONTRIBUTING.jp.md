# 開発に参加する

## ソースからのビルド

前提: Node.js、Git、.NET SDK（テスト アプリ用）、デバッグ エンジン用に Rust（`rustup`。ターゲット
`i686-pc-windows-msvc` と `x86_64-pc-windows-msvc`）と MSVC のリンカー（Visual Studio Build Tools の「C++ によるデスクトップ開発」）。
デバッグ エンジン **netdbg** は別のリポジトリ（[takahino/netdbg](https://github.com/takahino/netdbg)）です。このリポジトリの隣（`..\netdbg`）に clone してください。

```powershell
# デバッグ エンジンをビルド（x86 と x64。debugger\netdbg-x86 / -x64 に配置）し、コンパイル・VSIX 作成・VS Code へのインストールまで行う
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# VSIX の作成のみ（out\netdbg.vsix）
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipInstall

# エンジンのビルドと配置だけ。別の場所なら -EngineRepo、ビルドせずに dist\ を写すだけなら -SkipBuild
powershell -ExecutionPolicy Bypass -File scripts\build-engine.ps1 -EngineRepo ..\netdbg
```

`scripts\build-engine.ps1` は、エンジンの `build.ps1`（`dbgshim.dll` を版を固定して NuGet から取得します）を呼び、両方のビット数の
`netdbg.exe`、`dbgshim.dll`、エディット コンティニュの補助（`encdelta\`。C#。.NET SDK 9 以降でビルドし、デバッグのときは利用者の SDK の Roslyn で動きます）を写します。ICorDebug はプログラムと同じビット数のデバッガーでしか動かないため、拡張はセッションごとに
x86 か x64 のエンジンを起動します（`configProvider.ts` の `ENGINE_ARCHITECTURE_KEY`）。CI とリリースのワークフローは
`<owner>/netdbg` を `ENGINE_REF` の版で取得します。エンジンを新しくするときは、`ENGINE_REF` を書き換えて E2E テストを実行します。

拡張機能自体をデバッグするには、このフォルダを VS Code で開き **Run Extension**（F5）を実行します。

### エンジンとの API

拡張とエンジンの間でやり取りするものは `src/engineProtocol.ts`（JSDoc つきの TypeScript の型）で定義しています。変更したら
`npm run docs:api` で [docs/engine-api.html](docs/engine-api.html) と [docs/engine-api.json](docs/engine-api.json) を作り直してください。
古いままだと単体テストが失敗します（拡張が使う独自の要求とイベントがすべて載っていることも確かめます）。
`node scripts/gen-engine-api.js --engine ..\netdbg` で、エンジンが受け付ける要求の一覧とも突き合わせます。

### テスト

```powershell
npm test          # デバッガーを使わないロジックの単体テスト（高速）
npm run test:e2e  # E2E テスト: 本物のエンジンで test\apps のアプリをデバッグする（x86）
$env:NETDBG_E2E_ARCH = 'x64'; npm run test:e2e   # 同じものを x64 のエンジンと、x64 でビルドしたアプリで
```

E2E テストには、エンジン（`scripts\build-engine.ps1`）、.NET SDK、
試すビット数の .NET（Desktop）ランタイムが必要です。停止する行はテスト アプリの `// @名前` マーカーで探します。
デスクトップの無い環境では `NETDBG_SKIP_UI_TESTS=1` で WinForms のテストを飛ばせます。`NETDBG_E2E_DEBUGGER` で、
同じテストを別のビルドの netdbg（たとえばエンジンのリポジトリの `dist\`）に向けられます。[CI ワークフロー](.github/workflows/ci.yml) が push のたびに、
単体テストと両方のビット数の E2E テストを実行します。

単体テストは `src/test/unit` にあり、`vscode` モジュールに依存しないモジュール（`*Core.ts` など）をテストします。機能のロジックはそちらに書き、
VS Code 側を薄く保つと、この形でテストできます。DAP リレー（`dapProxy.ts`）は、台本（`FakeScenario`: 順に起きる停止と、そのフレーム・式の値）どおりに
DAP を返すエンジンの代役 `fakeDebugger.ts` に対してテストし、VS Code 側は `fakeClient.ts` が演じます。リレーが自分で判断すること（隠しブレークポイント、
ログポイント、マーカー、例外ログ、SQL ログ、イベント トレース）はこれでテストし、VS Code に届いたものと代役に送られたもの（`sentToDebugger()`）を確認します。
エンジン自体の振る舞い（ブレークポイントの結合、式の評価、ステップ実行）に依存することは E2E テストに書きます。

## リリース手順

1. `package.json` の `version` と `CHANGELOG.md` を更新し、`npm run docs:api` を実行して（エンジンの API の文書に版が出ます）、コミットします。
2. version と一致するタグを push します。

   ```powershell
   git tag v2.0.0
   git push origin v2.0.0
   ```

[Release ワークフロー](.github/workflows/release.yml)が `ENGINE_REF` のデバッグ エンジン（x86 と x64）のビルド・VSIX の作成を行い、
`netdbg-<version>.vsix` と `install-vsix.ps1` を添付した GitHub Release を作成します。
手動実行（*workflow_dispatch*）の場合は、ファイルをビルド成果物 (artifact) としてアップロードするだけです。
