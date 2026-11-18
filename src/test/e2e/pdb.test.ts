// PDB / PE reading against assemblies the .NET SDK built (test/apps): a side-by-side PDB, an embedded one, none.

import * as assert from 'assert/strict';
import * as path from 'path';
import { before, describe, it } from 'node:test';
import { readPdbDocuments } from '../../pdbDocuments';
import { engineArchitecture, inspectPe } from '../../peInfo';
import { ARCH, FRAMEWORK, buildApp, e2eSkip } from './harness';

describe('reading PDBs and PE headers', { skip: e2eSkip }, () => {
    let dir = '';
    before(() => {
        dir = buildApp('Basic');
    });

    it('reads the documents of a PDB next to the assembly, as the compiler recorded them', () => {
        const docs = readPdbDocuments(path.join(dir, 'MappedLib.dll'));
        assert.ok(docs.includes('C:\\fake\\src\\MappedLib\\Calc.cs'), docs.join(', '));
    });

    it('reads the documents of an embedded PDB', () => {
        const docs = readPdbDocuments(path.join(dir, 'EmbeddedLib.dll'));
        assert.ok(docs.includes('/_/Greeter.cs'), docs.join(', '));
    });

    it('finds no documents when there is no PDB', () => {
        assert.deepEqual(readPdbDocuments(path.join(dir, 'NoPdbLib.dll')), []);
    });

    it('finds no documents in a file that is not an assembly', () => {
        assert.deepEqual(readPdbDocuments(path.join(dir, 'Basic.deps.json')), []);
    });

    it('tells an x86 managed assembly from an AnyCPU one and from the native apphost', { skip: (ARCH !== 'x86' && 'the apps are built for x64') || (FRAMEWORK === 'net48' && 'a .NET Framework app has no apphost') }, () => {
        assert.deepEqual(inspectPe(path.join(dir, 'Basic.dll')), { bitness: 'x86', managed: true });
        assert.deepEqual(inspectPe(path.join(dir, 'MappedLib.dll')), { bitness: 'anycpu', managed: true });
        assert.deepEqual(inspectPe(path.join(dir, 'Basic.exe')), { bitness: 'x86', managed: false });
    });

    it('sees a .NET Framework exe as managed, of the bitness it is built for', { skip: FRAMEWORK !== 'net48' && 'the apps are built for .NET' }, () => {
        // An x64 build of a .NET Framework exe may come out AnyCPU (it runs as 64-bit too): what matters is the engine it gets.
        const exe = inspectPe(path.join(dir, 'Basic.exe'));
        assert.equal(exe.managed, true);
        assert.equal(engineArchitecture(exe.bitness), ARCH, exe.bitness);
        assert.equal(inspectPe(path.join(dir, 'MappedLib.dll')).managed, true);
    });

    it('sees the x64 apphost (the x64 engine debugs it)', { skip: (ARCH !== 'x64' && 'the apps are built for x86') || (FRAMEWORK === 'net48' && 'a .NET Framework app has no apphost') }, () => {
        assert.deepEqual(inspectPe(path.join(dir, 'Basic.exe')), { bitness: 'x64', managed: false });
    });
});
