# プロジェクトを x86 にする

プロジェクト ファイルに `PlatformTarget` を追加します。AnyCPU の exe は 64bit プロセスとして動いてしまいます。

```xml
<PropertyGroup>
  <PlatformTarget>x86</PlatformTarget>
  <!-- 旧形式の .NET Framework プロジェクトのみ: デバッガーは Portable PDB だけを読みます -->
  <DebugType>portable</DebugType>
</PropertyGroup>
```

SDK 形式のプロジェクトは最初から Portable PDB を出力します。**環境を確認** で変更が必要なプロジェクトが見つかり、ボタン 1 つで直せます。
