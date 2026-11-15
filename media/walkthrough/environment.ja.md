# 環境を確認する

デバッガー本体は同梱されています。このマシンに必要なもの:

| | 用途 |
|---|---|
| **.NET Runtime x86**（8 以降） | デバッガーの実行に使います。.NET Framework アプリでも常に必要です |
| **.NET Desktop Runtime x86** | .NET 5 以降の WinForms / WPF アプリ |
| **.NET SDK**（x64 で可） | `dotnet build` でのビルド |

x86 のランタイムは `C:\Program Files (x86)\dotnet` に入ります。*.NET Desktop Runtime x86* のインストーラーには両方のランタイムが含まれます。

**環境を確認** で、入っているもの・足りないものを一覧し、開いているフォルダーのプロジェクトも確認します。
