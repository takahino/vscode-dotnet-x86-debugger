# Make the project x86

Add `PlatformTarget` to the project file, or an AnyCPU exe runs as a 64-bit process:

```xml
<PropertyGroup>
  <PlatformTarget>x86</PlatformTarget>
  <!-- Old-style .NET Framework projects only: the debugger reads Portable PDBs -->
  <DebugType>portable</DebugType>
</PropertyGroup>
```

SDK-style projects write Portable PDBs already. **Check Environment** finds projects that need a change and fixes them with one click.
