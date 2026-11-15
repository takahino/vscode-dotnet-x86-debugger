# launch.json を作る

**launch.json を生成** は、フォルダー内の `.csproj` を読んで次を書き込みます。

- 実行可能なプロジェクトとターゲット フレームワークごとの起動構成（実際の出力パス `bin/x86/Debug/<tfm>/<name>.exe`）
- 実行中の x86 .NET プロセスから選んでアタッチする構成
- 起動前に実行する `tasks.json` の `build` タスク（`dotnet build -p:Platform=x86`）

launch.json がない状態で **F5** を押しても同じものが作られます。
