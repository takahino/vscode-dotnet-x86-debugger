# .NET x86 Debugger for VS Code

**32bit (x86) の .NET / .NET Framework 4.x アプリケーション**（たとえば `<PlatformTarget>x86</PlatformTarget>` でビルドした WinForms アプリ）を Visual Studio Code でデバッグするための拡張機能です。

C# 拡張のデバッガ (vsdbg) は x64 / arm64 版しか配布されていないため、32bit プロセスをデバッグできません。
この拡張は **[netcoredbg](https://github.com/Samsung/netcoredbg)（MIT）の x86 ビルド**を同梱し、デバッグ種別 `dotnet-x86` として登録します。

[English](README.md) · **はじめての方は [図解ガイド](https://takahino.github.io/vscode-dotnet-x86-debugger/usage.jp.html) をご覧ください**（[docs/usage.jp.html](docs/usage.jp.html)）

## 必要なもの

- Windows (x64)
- アプリに合った **x86 版 .NET ランタイム**（WinForms / WPF なら *.NET Desktop Runtime (x86)*）
  （`C:\Program Files (x86)\dotnet` にインストールされます）
- プロジェクトをビルドするための .NET SDK
- **.NET Framework 4.x** のアプリでは、さらに **x86 版 .NET ランタイム（8 以降）**。デバッガー自身の一部がその上で動きます

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

   プロセスの一覧には x86 の .NET プロセスだけが（ウィンドウタイトル付きで）表示されます。それ以外は「すべてのプロセスを表示...」から選べます。
   アプリの起動を待ってすぐにアタッチしたい場合（別のプログラムから起動されるアプリなど）は、名前を指定します:

   ```jsonc
   {
     "name": ".NET x86 Attach (wait for process)",
     "type": "dotnet-x86",
     "request": "attach",
     "processName": "MyApp",
     "waitTimeout": 120
   }
   ```

3. F5 を押します。

`tasks.json` を含む完全な例は [`samples/WinFormsX86`](samples/WinFormsX86) を、.NET Framework 4.8 版は
[`samples/WinFormsNet48X86`](samples/WinFormsNet48X86) を参照してください。
機能ごとにボタンを並べた **[`samples/FeatureTour`](samples/FeatureTour)**（.NET 10 / .NET Framework 4.8）で、各機能をひととおり試せます。

### .NET Framework 4.x

`.NET Framework` のアプリ（`net48`・`net472` など）も同じようにデバッグできます。`program` に x86 の `.exe`
（例: `bin/x86/Debug/net48/MyApp.exe`）を指定すると、拡張機能が .NET Framework の exe と判定し、.NET Framework のランタイムで起動します。アタッチもできます。

- プロジェクトは **Portable PDB** を出力する必要があります。SDK 形式のプロジェクトは既定で Portable です。古い形式のプロジェクトは既定で
  Windows PDB を出力するので、`<DebugType>portable</DebugType>` を追加してください（Windows PDB を見つけると警告が出ます）。
- 対応しているのは .NET Framework 4.x だけです（2.0 / 3.5 は非対応）。
- アプリ自体は使いませんが、x86 版 .NET ランタイム 8 以降のインストールが必要です。

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
| `sourceFileMap` | PDB に記録されたソースのパスの接頭辞を、ローカルのフォルダに置き換えます（下記参照）。attach でも使えます。 |
| `sourceSearchPaths` | PDB に記録された場所に無いソースを探すフォルダ（下記参照）。attach でも使えます。 |

### 設定

| 設定 | 説明 |
|---|---|
| `dotnetX86.debuggerPath` | 同梱版の代わりに、別の x86 版 `netcoredbg.exe` を使います。 |
| `dotnetX86.sourceFileMap` / `dotnetX86.sourceSearchPaths` | 全構成に共通の `sourceFileMap` / `sourceSearchPaths`（`${workspaceFolder}` が使えます）。 |
| `dotnetX86.trace` | トラブル調査用。デバッガとの通信を出力パネル「.NET x86 Debugger」に記録し、netcoredbg のログファイルも出力します（パスは同パネルに表示）。 |
| `dotnetX86.stepHistory.enabled` | 停止のたびにステップ履歴ビューへ記録します（既定値 `true`）。 |
| `dotnetX86.exceptionLog.enabled` | スローされたすべての例外を、止まらずに例外ログ ビューへ記録します（既定値 `true`）。 |
| `dotnetX86.perfTips.enabled` | ステップ実行や続行の後、停止行に経過時間を表示します（既定値 `true`）。 |
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

### ステップ履歴

「実行とデバッグ」の **ステップ履歴 (.NET x86)** ビューに、停止のたびの停止位置とローカル変数を新しい順に記録します。
同じメソッド内の直前の停止から変わった値には「変化」「新規」と表示されるので、「3 ステップ前の値」を見返せます
（履歴を閲覧するもので、実行を巻き戻すわけではありません）。項目をクリックするとその位置を開きます。
`dotnetX86.stepHistory.enabled` で無効にできます。

### 値の推移グラフ

C# ファイルの行を右クリックして **この行で値の推移を記録...** を選び、`;` 区切りで式を入力します（例: `total; items.Count`）。
その行を通るたびに止まらずに値を記録し、式ごとの小さなグラフにヒット回数順で表示します（**.NET x86: 値の推移を表示**）。
実体はメッセージが `#track:` で始まるログポイントなので、通常のブレークポイントと同じ方法で削除できます。

### ヒットカウント付きブレークポイント

ブレークポイントを編集して **ヒット カウント** を選び、`5` または `==5`（5 回目で停止）、`>=5` / `>5`（5 回目以降 / 5 回目より後）、
`%5`（5 回ごと）を入力します。条件（条件が真のときだけ数えます）やログメッセージと組み合わせることもできます。

### 一時・依存・値の変化ブレークポイント

C# エディターの行を右クリックします。

- **一時ブレークポイントを追加** — 1 回停止すると、そのブレークポイントは自動で削除されます（条件 `#once`）。
- **依存ブレークポイントを追加...** — 選んだ別のブレークポイントで一度停止した後にだけ有効になります（条件 `#after File.cs:12`）。
- **値が変化したときのブレークポイントを追加...** — その行を通るたびに式を評価し、前回と値が異なるときだけ停止します。変化前後の値はデバッグ コンソールに出力されます（条件 `#changed 式`）。

これらのマーカーは、任意のブレークポイントの条件として直接入力することもできます。ヒット カウントとも組み合わせられます。

### 値のピン止め

行を右クリックして **値を行にピン止め...** を選ぶと、式の値がその行の末尾に表示されます。プログラムが停止するたびに、
選択中のスタック フレームで評価し直します。ピン止めはワークスペースに保存されます。
**行のピン止めを解除** / **すべてのピン止めを解除** で外せます。

### WinForms コントロール ビュー

停止中、実行とデバッグの **WinForms コントロール** ビューに `Application.OpenForms` とそのコントロールがツリーで表示されます
（名前・型・テキスト。非表示のコントロールは淡色）。マウスを合わせると、位置とサイズ・有効/無効・Dock・TabIndex を表示します。
右クリックで **コントロールをダンプ** / **式をコピー**（例: `System.Windows.Forms.Application.OpenForms[0].Controls[1]`。ウォッチ式に貼り付けられます）。
値はすべて式の評価で読み取るため、子はノードを展開したときにだけ読み込みます。

### デバッグ セッションの報告書

**.NET x86: デバッグ セッションの報告書を出力**（またはステップ履歴ビューのタイトルにあるボタン）で、直前のセッションの報告書を
Markdown で開きます。プログラム・開始/終了時刻・終了コード、各停止と変化した値、例外（型ごとの件数付き）、区間の時間計測
（最小/平均/最大）、記録した値、シンボルのあるモジュールが含まれます。保存したり、不具合報告に貼り付けたりできます。

### 戻り値の表示

**ステップ オーバー**（または、自分のコードを呼ばない行でのステップ イン）と **ステップ アウト** の後、呼び出したメソッドの戻り値が
変数ビューと自動変数ビューの先頭に `Program.Square returned = 9` のように表示されます。1 行で複数のメソッドを呼んだ場合は、それぞれが表示されます。
オブジェクトは展開できます（表示は型名で、`DebuggerDisplay` は適用されません）。値は次のステップか続行で消えます。
`decimal`・`DateTime`・`Nullable<T>`・4 バイトより大きい構造体を返すメソッドは、x86 では隠しバッファー経由で値を返すため、戻り値は表示されません。

### 参照しているアセンブリのデバッグ（ソースが別の場所にある場合）

自作ライブラリ（自分でビルドした NuGet パッケージなど）の PDB に、このマシンに存在しないパスが記録されているときは、
ソースの場所を指定するとステップインやブレークポイントが効くようになります。

```jsonc
"justMyCode": false,                          // ライブラリが Release（最適化あり）でビルドされている場合
"sourceSearchPaths": ["D:\\work"],             // サブフォルダも含めて探し、末尾のフォルダが最も多く一致するファイルを使う
"sourceFileMap": { "/_/": "D:\\work\\MyLib\\" } // 接頭辞をそのまま置き換える（Deterministic ビルドは /_/ を記録する）
```

- ライブラリの PDB（Portable PDB）が、.dll に埋め込まれているか .dll の横にある必要があります。
- 起動するプログラムと同じフォルダにあるアセンブリの PDB は開始前に読むので、ライブラリ内のブレークポイントも最初から効きます。
  後から読み込まれるアセンブリ（およびアタッチ時）は、読み込まれた時点でブレークポイントを付け直します。
- どちらも `dotnetX86.sourceFileMap` / `dotnetX86.sourceSearchPaths` で全構成に共通の設定にできます。
- 停止位置のソースがこのマシンに無いときは、どの PDB パスを置き換えればよいかをデバッグ コンソールに表示します。

### Debug.WriteLine

`Debug.WriteLine`・`Trace.WriteLine`・`Debugger.Log` の出力は、ソース行へのリンク付きでデバッグ コンソールに表示されます。

### 例外ブレークポイント

ブレークポイント ビューに **すべての例外（スロー時）** と **ユーザーコードで未処理の例外** が表示されます。右クリックして
**条件の編集** を選ぶと、例外の型で絞り込めます（例: `System.NullReferenceException, System.InvalidOperationException`）。
先頭に `!` を付けると、指定した型以外のすべてで停止します。

### メモリ / CPU グラフ

コマンドパレットで **.NET x86: メモリ / CPU グラフを表示** を実行すると（または `dotnetX86.memoryGraph.autoOpen` を `true` にすると）、
デバッグ対象の **Private Bytes** と **Working Set**、および **CPU 使用率**（全コアに対する %、タスクマネージャーと同じ基準）を 1 秒ごとにグラフ表示します。Visual Studio の診断ツールのプロセスメモリ / CPU に相当します。
ブレークポイントやステップで停止していた区間は網掛けで表示されます。マウスを乗せると値が読め、*Data table* で直近の値を一覧できます。

### 値が変わったら停止

変数ビューでフィールド・プロパティ・ローカル変数を右クリックして **値の変更時に中断** を選びます。値が変わった直後に停止し、
`旧値 → 新値` を表示します。netcoredbg にデータブレークポイントが無いため、エミュレーションで実現しています。
ワークスペースの C# ファイルからその名前への代入箇所（`x = …`、`x += …`、`x++` など）を探し、各箇所の前後で値を比べて、
変わったときだけ停止します。`ref` / `out` 経由の書き換え、別オブジェクトのメンバーへの代入（`other.x = …`）、
ワークスペース外のコードによる書き換えは検出できません。

### 次のステートメントの設定

停止中、実行中のメソッドの行を右クリックして **カーソル行へジャンプ**（次のステートメントの設定）を選ぶと、実行位置をそこへ移します。
Visual Studio と同様に、行をもう一度実行したり、行を飛ばしたりできます。実行中のメソッド外の行や、catch / finally ブロックの内外を
またぐ移動はできません。

### PerfTips

ステップ実行や続行の後、停止行に経過時間（例: `≤ 12 ms 経過`）を表示します。デバッガ自体の処理時間を含むため「≤」を付けています。

### 区間の時間計測

行を右クリックして **ここから時間を計測...** を選び、後の行で **ここまでの時間を計測...** を選びます。開始から終了までの各回の時間を
止まらずに計測し、**値の推移** ビュー（`⏱ 名前 (ms)`）とデバッグコンソールに出力します。各回に数 ms のデバッガのオーバーヘッドが含まれます。

### 例外ログ

**例外ログ (.NET x86)** ビューに、デバッグ対象でスローされたすべての例外（catch して握りつぶされたものも含む）を、型・メッセージ・
自分のコード内の発生場所とともに一覧表示します（クリックでその場所を開きます）。デバッグコンソールにも Visual Studio の
`Exception thrown: …` と同じ形式で出力します。実行が止まるのは、例外設定で指定した場合だけです。
例外を大量にスローするアプリでは、有効にすると動作が遅くなります（`dotnetX86.exceptionLog.enabled`）。

### 自動変数・モジュール ビュー

- **自動変数 (.NET x86)**: 選択中のフレームの現在行と直前の行で使われている変数を表示します（Visual Studio の自動変数ウィンドウ相当）。
- **モジュール (.NET x86)**: 読み込まれたアセンブリと、シンボル（PDB）の読み込み状況を表示します。右クリックでパスのコピーや
  エクスプローラーでの表示ができます。

### 変数ビューの右クリックメニューにあるその他のコマンド

| コマンド | 内容 |
|---|---|
| **View as Table（表として表示）** | `List<T>`・配列・`Dictionary`・`DataTable` を表で表示します。列見出しで並べ替え、行の絞り込み、CSV のコピー・保存ができます。要素がオブジェクトの場合はメンバーごとに列になり、日付は `ToString()` で表示します。DataTable は最大 1,000 行まで読み込みます。 |
| **Copy as C# Initializer** | 値を C# のコード（`var order = new Order { Note = "...", People = new List<Person> { ... } };`）としてコピーします。テストデータ作りに便利です。PascalCase のメンバーだけを出力します。get 専用プロパティも含まれるので、コンパイルが通らない場合は削除してください。 |
| **View String (JSON / XML / HTML / Text)** | string 型の変数をエディタで開きます。中身が JSON・XML・HTML なら整形して表示します（自動判定、または形式を選択）。 |
| **Take Snapshot** / **Compare with Snapshot** | 変数の値を記録しておき、ステップ実行や続行の後に現在の値との差分を表示します。どこで何が変わったかを追えます。 |

### 表示言語

メニュー・設定・メッセージは、VS Code の表示言語が日本語のとき（Japanese Language Pack を入れている場合など）は日本語、それ以外では英語で表示されます。
メニューの日本語名は「変数をダンプ」「C# の初期化子としてコピー」「文字列を表示」「スナップショットを記録」「スナップショットと比較」「メモリグラフを表示」です。

## 制限事項

- **.NET Framework**: 4.x のみ、Portable PDB が必要です（上記参照）。
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
