# Feature Tour（機能ツアー）

.NET x86 Debugger の機能をひととおり試せる WinForms アプリです。ボタン 1 つが 1 つのデモで、止める行は
[Demos.cs](Demos.cs) の `[番号]` コメントで示しています。[English](README.md)

同じソースを **.NET 10** と **.NET Framework 4.8**（どちらも x86）でビルドするので、各デモをどちらのランタイムでも試せます。

## はじめに

1. このフォルダー（`samples/FeatureTour`）を VS Code で開きます。
2. 実行とデバッグで **Feature Tour (.NET 10, x86)** か **Feature Tour (.NET Framework 4.8, x86)** を選び、F5 を押します。
   `build` タスクが両方をビルドします（.NET Framework 版でも、デバッガー用に x86 版 .NET ランタイム 8 以降が必要です）。
3. ウィンドウのタイトルに、ランタイムと `(32-bit)` が表示されます。

## デモ

| # | ボタン | 試すこと |
|---|---|---|
| 1 | Loop: breakpoints / logpoints / hit count | `[1]` の行に **条件付きブレークポイント** `order.Amount > 1500`、**ヒット カウント** `>=150`、**ログポイント** `i={i} total={total}`（デバッグ コンソールに出力）。停止中は行末の **インライン値**、**自動変数** ビュー、`total` で **値を行にピン止め...**、何回か F10 した後の **ステップ履歴** も確認できます。`bigOrders++` の行で **値が変化したときのブレークポイントを追加...** に `bigOrders`。 |
| 2a / 2b | Save (without import) / Import, then save | `Import();`（`[2]`）にブレークポイントを置き、`Save` の `Log` 行で **依存ブレークポイントを追加...** からそれを選びます。2a では止まらず、2b では止まります。同じ行の **一時ブレークポイントを追加** は 1 回止まると消えます。 |
| 3 | Return values | `[3]` で止めてステップ オーバー（F10）すると、変数ビューと自動変数ビューに `MainForm.IsValid returned` / `HasStock returned` が出ます（`IsValid` が false のときは `&&` で打ち切られるので `IsValid` だけ）。次の `[3]` の行では `Points` と `Bonus` の両方が出ます。`decimal rounded` の行は制限の確認用で、隠しバッファー経由で返る値は表示されません。 |
| 4 | Who changes the status? | `[4]` で止め、変数ビューで `this` を展開して `_status` を右クリック >「値の変更時に中断」。続行すると、代入のたびに `New → Approved` のように止まります。約半分の回（時刻の秒が偶数のとき）は、思わぬ `Cancel()` が入ります。 |
| 5 | Invoice (set next statement) | `taxRate` が 0.08 ではなく 0.8 になっています。`tax` の行で止め、`taxRate` を `0.08` に **値の設定**、`tax` の行を右クリック >「カーソル行へジャンプ」、もう一度ステップ オーバーします。 |
| 6 | Exceptions (thrown and swallowed) | 画面には何も出ませんが、**例外ログ** ビューに `FormatException` と `NullReferenceException` が行へのリンク付きで並びます。ブレークポイント ビューで「すべての例外」を有効にし、右クリック >「条件の編集」に `System.FormatException` と入れると、その型だけで止まります。 |
| 7 | Debug.WriteLine / Trace | 3 つのメッセージが、行へのリンク付きで **デバッグ コンソール** に出ます。 |
| 8 | Slow load (PerfTips / timing) | `[8]` の行をステップ オーバーすると、**PerfTips** が行末に経過時間を表示します。`LoadCustomers();` を右クリック > **ここから時間を計測...**、下の `Log` 行 > **ここまでの時間を計測...** を設定してもう一度押すと、**値の推移** グラフで 3 回目が遅いことが分かります。 |
| 9 | Sensor (value trend) | `[9]` の行を右クリック > **この行で値の推移を記録...** に `temperature; average` と入れて押すと、止まらずに 100 回分の値がグラフになります。 |
| 10 | Customer data (Variables view) | `[10]` で止め、変数ビューで右クリック: `customer` > **変数をダンプ**・**C# の初期化子としてコピー**・**スナップショットを記録**、`orders` か `table` > **表として表示**、`json`・`xml`・`longText` > **文字列を表示**。2 行ステップ オーバーしてから `customer` > **スナップショットと比較**。`Order` と `Customer` には `[DebuggerDisplay]` が付いています。 |
| 11a〜c | Memory / CPU | 先に **.NET x86: メモリ / CPU グラフを表示** を実行します。11a は押すたびに 50 MB を保持し（リークのように Private Bytes が下がらない）、11b で解放、11c は 3 秒間 CPU を 1 コア使います。 |
| 12 | Inspect controls | `[12]` で止めて **WinForms コントロール** ビューを開き、`hiddenControlsGroup` / `innerPanel` の下で `disabledBox`（無効）、`hiddenLabel`（非表示で淡色）、`lostButton`（200 × 60 の親の範囲外）を探します。マウスを合わせると位置とサイズが、右クリックで **コントロールをダンプ** ができます。 |

## そのほか

- **アタッチ**: エクスプローラーから `bin/x86/Debug/<ターゲット>/FeatureTour.exe` を起動し、**Attach (pick a process)**。
  または先に **Attach (wait for FeatureTour to start)** を開始し、後からアプリを起動します。
- **モジュール** ビュー: `FeatureTour` は「シンボル読み込み済み」、フレームワークのアセンブリはシンボルなしです。
- いくつかデモを試した後に **デバッグ セッションの報告書を出力**（ステップ履歴ビューのタイトルのボタン）: 停止・変化した値・例外・時間計測・モジュールが 1 つの Markdown にまとまります。
