import * as path from 'path';
import * as vscode from 'vscode';
import { X86AdapterFactory } from './adapterFactory';
import { AutosView } from './autosView';
import { BreakpointCommands } from './breakpointCommands';
import { DEBUG_TYPE, X86ConfigurationProvider } from './configProvider';
import { ControlNode, ControlTree } from './controlTree';
import { DapTraceFactory } from './dapTrace';
import { Decompiler } from './decompiler';
import { ExceptionLog } from './exceptionLog';
import { ExceptionSettings } from './exceptionSettings';
import { CSharpInlineValuesProvider } from './inlineValues';
import { MemoryMonitor } from './memoryMonitor';
import { ParallelStacks } from './parallelStacks';
import { HeapSnapshots } from './heapSnapshots';
import { PerfTips } from './perfTips';
import { PinnedValues } from './pinnedValues';
import { ModuleList, copyModulePath, revealModule } from './moduleList';
import { makeObjectIdCommand } from './objectIdCommand';
import { SessionReport } from './sessionReport';
import { StepHistory } from './stepHistory';
import { SymbolServer } from './symbolServer';
import { generateTestCommand } from './testGenerator';
import { viewAsImageCommand } from './imageVisualizer';
import { viewAsTableCommand } from './tableVisualizer';
import { UiFreezeDetector } from './uiFreeze';
import { ValueTracker } from './valueTracker';
import { WindowHighlighter } from './windowHighlight';
import { pickProcess } from './processPicker';
import {
    SNAPSHOT_SCHEME,
    SnapshotStore,
    compareWithSnapshotCommand,
    copyAsCSharpCommand,
    dumpExpressionCommand,
    dumpVariableCommand,
    takeSnapshotCommand,
    viewStringCommand,
} from './variableDump';

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('.NET x86 Debugger');
    const snapshots = new SnapshotStore();
    const memory = new MemoryMonitor(output);
    const valueTracker = new ValueTracker();
    const stepHistory = new StepHistory();
    const moduleList = new ModuleList();
    const perfTips = new PerfTips();
    const autos = new AutosView();
    const breakpointCommands = new BreakpointCommands();
    const pinnedValues = new PinnedValues(context.workspaceState);
    const controlTree = new ControlTree();
    const controlView = vscode.window.createTreeView('dotnetX86.controls', { treeDataProvider: controlTree });
    controlTree.attach(controlView);
    const highlighter = new WindowHighlighter(context.extensionPath, (line) => output.appendLine(line));
    const exceptionLog = new ExceptionLog();
    const exceptionView = vscode.window.createTreeView('dotnetX86.exceptions', { treeDataProvider: exceptionLog });
    exceptionLog.attach(exceptionView);
    const exceptionSettings = new ExceptionSettings(context.workspaceState);
    const exceptionSettingsView = vscode.window.createTreeView('dotnetX86.exceptionSettings', { treeDataProvider: exceptionSettings, manageCheckboxStateManually: true });
    exceptionSettings.attach(exceptionSettingsView);
    const decompiler = new Decompiler(context.extensionPath, path.join(context.globalStorageUri.fsPath, 'decompiled'), output);
    const symbolServer = new SymbolServer(path.join(context.globalStorageUri.fsPath, 'symbols'), path.join(context.globalStorageUri.fsPath, 'sources'), output);
    const parallelStacks = new ParallelStacks();
    const heapSnapshots = new HeapSnapshots();
    const sessionReport = new SessionReport(stepHistory, exceptionLog, moduleList, valueTracker);

    context.subscriptions.push(
        output,
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new X86ConfigurationProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new X86AdapterFactory(context.extensionPath, context.logUri.fsPath, output, { decompiled: decompiler.cacheRoot, symbols: symbolServer.symbolCache, sources: symbolServer.sourceCache }, () => exceptionSettings.checkedTypes())),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, new DapTraceFactory(output)),
        vscode.commands.registerCommand('dotnetX86.pickProcess', pickProcess),
        vscode.commands.registerCommand('dotnetX86.dumpVariable', dumpVariableCommand),
        vscode.commands.registerCommand('dotnetX86.dumpExpression', dumpExpressionCommand),
        vscode.commands.registerCommand('dotnetX86.copyAsCSharp', copyAsCSharpCommand),
        vscode.commands.registerCommand('dotnetX86.makeObjectId', makeObjectIdCommand),
        vscode.commands.registerCommand('dotnetX86.generateTest', generateTestCommand),
        vscode.commands.registerCommand('dotnetX86.decompileModule', (module?: { name?: string; path?: string }) => decompiler.decompile(module)),
        vscode.commands.registerCommand('dotnetX86.clearDecompiled', () => decompiler.clearCache()),
        parallelStacks,
        vscode.commands.registerCommand('dotnetX86.showParallelStacks', () => parallelStacks.show()),
        vscode.commands.registerCommand('dotnetX86.freezeThread', (arg?: { threadId?: number; sessionId?: string }) => parallelStacks.setFrozen(arg, true)),
        heapSnapshots,
        vscode.commands.registerCommand('dotnetX86.showHeapSnapshots', () => heapSnapshots.show()),
        vscode.commands.registerCommand('dotnetX86.takeHeapSnapshot', () => heapSnapshots.take()),
        vscode.commands.registerCommand('dotnetX86.thawThread', (arg?: { threadId?: number; sessionId?: string }) => parallelStacks.setFrozen(arg, false)),
        vscode.commands.registerCommand('dotnetX86.downloadSymbols', (module?: { name?: string; path?: string }) => symbolServer.download(module)),
        vscode.commands.registerCommand('dotnetX86.clearDownloadedSymbols', () => symbolServer.clearCache()),
        vscode.commands.registerCommand('dotnetX86.viewString', viewStringCommand),
        vscode.commands.registerCommand('dotnetX86.takeSnapshot', (arg) => takeSnapshotCommand(snapshots, arg)),
        vscode.commands.registerCommand('dotnetX86.compareWithSnapshot', (arg) => compareWithSnapshotCommand(snapshots, arg)),
        vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshots),
        memory,
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, memory),
        vscode.commands.registerCommand('dotnetX86.showMemoryGraph', () => memory.show()),
        vscode.languages.registerInlineValuesProvider('csharp', new CSharpInlineValuesProvider()),
        valueTracker,
        vscode.commands.registerCommand('dotnetX86.trackValue', () => valueTracker.addTracker()),
        vscode.commands.registerCommand('dotnetX86.showValueTrend', () => valueTracker.show()),
        vscode.commands.registerCommand('dotnetX86.startTimer', () => valueTracker.addTimerStart()),
        vscode.commands.registerCommand('dotnetX86.endTimer', () => valueTracker.addTimerEnd()),
        stepHistory,
        vscode.window.createTreeView('dotnetX86.stepHistory', { treeDataProvider: stepHistory }),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, stepHistory),
        vscode.commands.registerCommand('dotnetX86.clearStepHistory', () => stepHistory.clear()),
        vscode.commands.registerCommand('dotnetX86.viewAsTable', viewAsTableCommand),
        vscode.commands.registerCommand('dotnetX86.viewAsImage', viewAsImageCommand),
        moduleList,
        vscode.window.createTreeView('dotnetX86.modules', { treeDataProvider: moduleList }),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, moduleList),
        vscode.commands.registerCommand('dotnetX86.copyModulePath', copyModulePath),
        vscode.commands.registerCommand('dotnetX86.revealModule', revealModule),
        perfTips,
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, perfTips),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, new UiFreezeDetector(context.extensionPath, output)),
        autos,
        vscode.window.createTreeView('dotnetX86.autos', { treeDataProvider: autos }),
        breakpointCommands,
        vscode.commands.registerCommand('dotnetX86.addTemporaryBreakpoint', () => breakpointCommands.addTemporary()),
        vscode.commands.registerCommand('dotnetX86.addDependentBreakpoint', () => breakpointCommands.addDependent()),
        vscode.commands.registerCommand('dotnetX86.addWhenChangedBreakpoint', () => breakpointCommands.addWhenChanged()),
        vscode.commands.registerCommand('dotnetX86.addCallerBreakpoint', () => breakpointCommands.addCallerFiltered()),
        pinnedValues,
        vscode.commands.registerCommand('dotnetX86.pinValue', () => pinnedValues.pin()),
        vscode.commands.registerCommand('dotnetX86.unpinValue', () => pinnedValues.unpin()),
        vscode.commands.registerCommand('dotnetX86.clearPinnedValues', () => pinnedValues.clear()),
        controlTree,
        controlView,
        vscode.commands.registerCommand('dotnetX86.refreshControlTree', () => controlTree.refresh()),
        vscode.commands.registerCommand('dotnetX86.dumpControl', (node: ControlNode) => dumpExpressionCommand(node?.expression)),
        highlighter,
        vscode.commands.registerCommand('dotnetX86.breakOnControlEvent', (node?: ControlNode) => controlTree.breakOnEvent(node ?? controlView.selection[0])),
        vscode.commands.registerCommand('dotnetX86.editControlProperty', (node?: ControlNode) => controlTree.editProperty(node ?? controlView.selection[0])),
        vscode.commands.registerCommand('dotnetX86.highlightControl', (node?: ControlNode) => controlTree.highlight(node ?? controlView.selection[0], highlighter)),
        vscode.commands.registerCommand('dotnetX86.copyControlExpression', (node: ControlNode) => node && vscode.env.clipboard.writeText(node.expression)),
        exceptionLog,
        exceptionView,
        vscode.commands.registerCommand('dotnetX86.clearExceptionLog', () => exceptionLog.clear()),
        exceptionSettings,
        exceptionSettingsView,
        vscode.commands.registerCommand('dotnetX86.addExceptionType', () => exceptionSettings.addType()),
        vscode.commands.registerCommand('dotnetX86.removeExceptionType', (node) => exceptionSettings.removeType(node)),
        vscode.commands.registerCommand('dotnetX86.uncheckExceptionTypes', () => exceptionSettings.uncheckAll()),
        vscode.commands.registerCommand('dotnetX86.breakOnExceptionType', (entry?: { typeName?: string }) => entry?.typeName && exceptionSettings.addType(entry.typeName)),
        sessionReport,
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, sessionReport),
        vscode.commands.registerCommand('dotnetX86.exportSessionReport', () => sessionReport.export()),
    );
}

export function deactivate(): void {}
