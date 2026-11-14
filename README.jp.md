# .NET x86 Debugger for VS Code

**32bit (x86) の .NET アプリケーション**（たとえば `<PlatformTarget>x86</PlatformTarget>` でビルドした WinForms アプリ）を Visual Studio Code でデバッグするための拡張機能です。

C# 拡張のデバッガ (vsdbg) は x64 / arm64 版しか配布されていないため、32bit プロセスをデバッグできません。
この拡張は **[netcoredbg](https://github.com/Samsung/netcoredbg)（MIT）の x86 ビルド**を同梱し、デバッグ種別 `dotnet-x86` として登録します。

[English](README.md)

## 必要なもの

- Windows (x64)
- アプリに合った **x86 版 .NET ランタイム**（WinForms / WPF なら *.NET Desktop Runtime (x86)*）
  （`C:\Program Files (x86)\dotnet` にインストールされます）
- プロジェクトをビルドするための .NET SDK

## 使い方

1. プロジェクトを 32bit にします。

   ```xml
   <PropertyGroup>
     <TargetFramework>net10.0-windows</TargetFramework>
     <PlatformTarget>x86</PlatformTarget>
   </PropertyGroup>
   ```

2. `.vscode/launch.json` に構成を追加します。

   ```jsonc
   {
     "name": ".NET x86 Launch",
     "type": "dotnet-x86",
     "request": "launch",
     "preLaunchTask": "build",
     "program": "${workspaceFolder}/bin/x86/Debug/net10.0-windows/MyApp.exe",
     "args": [],
     "cwd": "${workspaceFolder}",
     "stopAtEntry": false
   }
   ```

   実行中のプロセスにアタッチする場合:

   ```jsonc
   {
     "name": ".NET x86 Attach",
     "type": "dotnet-x86",
     "request": "attach",
     "processId": "${command:pickProcess}"
   }
   ```

3. F5 を押します。

`tasks.json` を含む完全な例は [`samples/WinFormsX86`](samples/WinFormsX86) を参照してください。

### launch のオプション

| オプション | 説明 |
|---|---|
| `program` | x86 の `.exe` へのパス。framework-dependent な `.dll` も指定でき、その場合は x86 版 `dotnet.exe` で起動します。 |
| `args` | コマンドライン引数。 |
| `cwd` | 作業ディレクトリ。 |
| `env` | 環境変数。 |
| `stopAtEntry` | エントリポイントで停止します。 |
| `justMyCode` | ユーザーコードのみをデバッグします（既定値 `true`）。 |
| `enableStepFiltering` | プロパティや演算子をステップオーバーします（既定値 `true`）。 |

### 設定

| 設定 | 説明 |
|---|---|
| `dotnetX86.debuggerPath` | 同梱版の代わりに、別の x86 版 `netcoredbg.exe` を使います。 |

## 制限事項

- **.NET Framework には対応していません。** netcoredbg が .NET (Core) / .NET 5 以降のみに対応しているためです。
- デバッグ対象の出力は常にデバッグコンソールに表示されます（`console: integratedTerminal` は使えません）。
- Windows 専用です。

## ソースからのビルド

前提: Node.js、Git、.NET SDK、Visual Studio 2022 以降（「C++ によるデスクトップ開発」ワークロード）。

```powershell
# netcoredbg を x86 向けにビルド（debugger\netcoredbg-x86 に配置）し、コンパイル・VSIX 作成・VS Code へのインストールまで行う
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# VSIX の作成のみ（out\dotnet-x86-debugger.vsix）
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipInstall
```

`scripts\build-netcoredbg.ps1` は、Windows の `MAX_PATH` 制限に収まるよう、netcoredbg（タグ固定）と `dotnet/runtime` の必要な部分だけを
短い作業ディレクトリ（既定は `%LOCALAPPDATA%\ncdbg`）に取得してビルドします。

拡張機能自体をデバッグするには、このフォルダを VS Code で開き **Run Extension**（F5）を実行します。

## ライセンス

[MIT](LICENSE)。同梱しているサードパーティ製コンポーネントは [ThirdPartyNotices.txt](ThirdPartyNotices.txt) に記載しています。
