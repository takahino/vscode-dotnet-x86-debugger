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

## インストール

1. [Releases](https://github.com/takahino/vscode-dotnet-x86-debugger/releases) から
   `dotnet-x86-debugger-<version>.vsix` と `install-vsix.ps1` を同じフォルダにダウンロードします。
2. 次を実行します。

   ```powershell
   powershell -ExecutionPolicy Bypass -File install-vsix.ps1
   ```

   VS Code の **Extensions: Install from VSIX...** で `.vsix` を選んでインストールすることもできます。

3. VS Code を再読み込みします（**Developer: Reload Window**）。

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
| `dotnetX86.trace` | トラブル調査用。デバッガとの通信を出力パネル「.NET x86 Debugger」に記録し、netcoredbg のログファイルも出力します（パスは同パネルに表示）。 |
| `dotnetX86.memoryGraph.autoOpen` | デバッグ開始時にメモリグラフを自動で開きます（既定値 `false`）。 |
| `dotnetX86.dump.maxDepth` | *Dump Variable* で展開する入れ子の深さ（既定値 `3`）。 |
| `dotnetX86.dump.maxNodes` | この数の値を集めた時点で、それ以上の展開をやめます（既定値 `2000`）。 |

### Dump Variable（変数のダンプ）

停止中に **変数** ビューで変数を右クリックして **Dump Variable** を選ぶか、
コマンドパレットで **.NET x86: Dump Expression...** を実行すると、オブジェクト全体を JSON としてエディタに表示します。

```json
{
  "p": {
    "$type": "Person",
    "Name": "Alice",
    "Friends": [ { "$type": "Person", "Name": "Bob" } ],
    "Scores": { "math": 90 }
  }
}
```

- `List<T>` と `Dictionary<TKey, TValue>` は、Visual Studio の *Results View* のように要素だけを表示します。
- static メンバー、明示的なインターフェイス実装、インデクサは省略します。
- 変数ビューと同様に、ダンプ中もプロパティの getter が実行されます。`Form` のような大きなオブジェクトは上記の上限に達します
  （その旨が通知されます）。必要なら設定で上限を上げてください。

### インライン値表示

停止中、現在のメソッドの各行の末尾に値を表示します（Visual Studio のインライン値に相当）。対象はローカル変数・引数と、
フィールド（`_count`、`this._count`）です。プロパティは getter が実行されるため表示しません。
VS Code の設定 `debug.inlineValues` で無効にできます。

### DebuggerDisplay

`[DebuggerDisplay("Name = {Name}, Age = {Age}")]` を付けた型は、Visual Studio と同様に変数ビュー・ホバー・ウォッチでその書式で表示されます
（`List<T>` は `Count = 3`）。メンバー参照とメソッド呼び出しに対応し、`,nq` で文字列の引用符を外せます。属性は派生クラスにも継承されます。
式はオブジェクトを起点に評価するため、演算子やキャストを含む複雑な式は従来の `{型名}` 表示になります。

### ログポイント

エディタの行番号の左を右クリックして **Add Logpoint...（ログポイントの追加）** を選び、
`i={i} total={total} in $FUNCTION` のようなメッセージを入力します。その行を通るたびにメッセージがデバッグコンソールに出力され、
実行は止まらずに続きます。`{式}` は現在のフレームで評価され、`$FUNCTION` と `$TID` はメソッド名とスレッド ID に置き換わります。
条件と組み合わせることもできます。

### ヒットカウント付きブレークポイント

ブレークポイントを編集して **ヒット カウント** を選び、`5` または `==5`（5 回目で停止）、`>=5` / `>5`（5 回目以降 / 5 回目より後）、
`%5`（5 回ごと）を入力します。条件（条件が真のときだけ数えます）やログメッセージと組み合わせることもできます。

### 例外ブレークポイント

ブレークポイント ビューに **すべての例外（スロー時）** と **ユーザーコードで未処理の例外** が表示されます。右クリックして
**条件の編集** を選ぶと、例外の型で絞り込めます（例: `System.NullReferenceException, System.InvalidOperationException`）。
先頭に `!` を付けると、指定した型以外のすべてで停止します。

### メモリ / CPU グラフ

コマンドパレットで **.NET x86: メモリ / CPU グラフを表示** を実行すると（または `dotnetX86.memoryGraph.autoOpen` を `true` にすると）、
デバッグ対象の **Private Bytes** と **Working Set**、および **CPU 使用率**（全コアに対する %、タスクマネージャーと同じ基準）を 1 秒ごとにグラフ表示します。Visual Studio の診断ツールのプロセスメモリ / CPU に相当します。
ブレークポイントやステップで停止していた区間は網掛けで表示されます。マウスを乗せると値が読め、*Data table* で直近の値を一覧できます。

### 変数ビューの右クリックメニューにあるその他のコマンド

| コマンド | 内容 |
|---|---|
| **Copy as C# Initializer** | 値を C# のコード（`var order = new Order { Note = "...", People = new List<Person> { ... } };`）としてコピーします。テストデータ作りに便利です。PascalCase のメンバーだけを出力します。get 専用プロパティも含まれるので、コンパイルが通らない場合は削除してください。 |
| **View String (JSON / XML / HTML / Text)** | string 型の変数をエディタで開きます。中身が JSON・XML・HTML なら整形して表示します（自動判定、または形式を選択）。 |
| **Take Snapshot** / **Compare with Snapshot** | 変数の値を記録しておき、ステップ実行や続行の後に現在の値との差分を表示します。どこで何が変わったかを追えます。 |

### 表示言語

メニュー・設定・メッセージは、VS Code の表示言語が日本語のとき（Japanese Language Pack を入れている場合など）は日本語、それ以外では英語で表示されます。
メニューの日本語名は「変数をダンプ」「C# の初期化子としてコピー」「文字列を表示」「スナップショットを記録」「スナップショットと比較」「メモリグラフを表示」です。

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
netcoredbg への独自修正は [`patches/netcoredbg`](patches/netcoredbg) にあり、ビルド時に自動で適用されます。

拡張機能自体をデバッグするには、このフォルダを VS Code で開き **Run Extension**（F5）を実行します。

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

## ライセンス

[MIT](LICENSE)。同梱しているサードパーティ製コンポーネントは [ThirdPartyNotices.txt](ThirdPartyNotices.txt) に記載しています。
