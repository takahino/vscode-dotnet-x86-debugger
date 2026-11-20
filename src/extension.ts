import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { X86AdapterFactory } from './adapterFactory';
import { AutosView } from './autosView';
import { BreakpointCommands } from './breakpointCommands';
import { DEBUG_TYPE, X86ConfigurationProvider } from './configProvider';
import { ControlNode, ControlTree } from './controlTree';
import { DataBindingsPanel } from './dataBindings';
import { isEnabled } from './features';
import { DapTraceFactory } from './dapTrace';
import { EditAndContinue } from './editAndContinue';
import { ExceptionLog } from './exceptionLog';
import { ExceptionSettings } from './exceptionSettings';
import { CSharpInlineValuesProvider } from './inlineValues';
import { MemoryMonitor } from './memoryMonitor';
import { ParallelStacks } from './parallelStacks';
import { HeapSnapshots } from './heapSnapshots';
import { EnvironmentCheck } from './environmentCheck';
import { generateLaunchJsonCommand } from './launchSetup';
import { PerfTips } from './perfTips';
import { PinnedValues } from './pinnedValues';
import { ModuleList, copyModulePath, revealModule } from './moduleList';
import { McpIntegration } from './mcp';
import { makeObjectIdCommand } from './objectIdCommand';
import { SessionReport } from './sessionReport';
import { EventTrace } from './eventTrace';
import { EvidenceCapture } from './evidence';
import { SqlLog } from './sqlLog';
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
    const memory = new MemoryMonitor(context.extensionPath, output);
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
    const dataBindings = new DataBindingsPanel((node) => controlTree.highlight(node, highlighter));
    const exceptionLog = new ExceptionLog();
    const exceptionView = vscode.window.createTreeView('dotnetX86.exceptions', { treeDataProvider: exceptionLog });
    exceptionLog.attach(exceptionView);
    const eventTrace = new EventTrace();
    const eventTraceView = vscode.window.createTreeView('dotnetX86.eventTrace', { treeDataProvider: eventTrace });
    eventTrace.attach(eventTraceView);
    const sqlLog = new SqlLog();
    const evidence = new EvidenceCapture(context.extensionPath, sqlLog, (line) => output.appendLine(line));
    const sqlView = vscode.window.createTreeView('dotnetX86.sqlLog', { treeDataProvider: sqlLog });
    sqlLog.attach(sqlView);
    const exceptionSettings = new ExceptionSettings(context.workspaceState);
    const exceptionSettingsView = vscode.window.createTreeView('dotnetX86.exceptionSettings', { treeDataProvider: exceptionSettings, manageCheckboxStateManually: true });
    exceptionSettings.attach(exceptionSettingsView);
    // The ILSpy helper (Decompile for Debugging, 1.x) left its symbols here; the engine now decompiles by itself.
    removeOldDecompiledCache(path.join(context.globalStorageUri.fsPath, 'decompiled'), output);
    const symbolServer = new SymbolServer(path.join(context.globalStorageUri.fsPath, 'symbols'), path.join(context.globalStorageUri.fsPath, 'sources'), output);
    const parallelStacks = new ParallelStacks();
    const heapSnapshots = new HeapSnapshots();
    const environmentCheck = new EnvironmentCheck(context.extensionPath);
    const sessionReport = new SessionReport(stepHistory, exceptionLog, moduleList, valueTracker);
    const mcp = new McpIntegration(context.extensionPath, output);
    const editAndContinue = new EditAndContinue(output);

    context.subscriptions.push(
        output,
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new X86ConfigurationProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new X86AdapterFactory(context.extensionPath, context.logUri.fsPath, output, { symbols: symbolServer.symbolCache, sources: symbolServer.sourceCache }, () => (isEnabled('exceptionSettings') ? exceptionSettings.checkedTypes() : []))),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, new DapTraceFactory(output)),
        vscode.commands.registerCommand('dotnetX86.pickProcess', pickProcess),
        vscode.commands.registerCommand('dotnetX86.dumpVariable', dumpVariableCommand),
        vscode.commands.registerCommand('dotnetX86.dumpExpression', dumpExpressionCommand),
        vscode.commands.registerCommand('dotnetX86.copyAsCSharp', copyAsCSharpCommand),
        vscode.commands.registerCommand('dotnetX86.makeObjectId', makeObjectIdCommand),
        vscode.commands.registerCommand('dotnetX86.generateTest', generateTestCommand),

        parallelStacks,
        vscode.commands.registerCommand('dotnetX86.showParallelStacks', () => parallelStacks.show()),
        vscode.commands.registerCommand('dotnetX86.freezeThread', (arg?: { threadId?: number; sessionId?: string }) => parallelStacks.setFrozen(arg, true)),
        heapSnapshots,
        environmentCheck,
        vscode.commands.registerCommand('dotnetX86.checkEnvironment', () => environmentCheck.show()),
        vscode.commands.registerCommand('dotnetX86.generateLaunchJson', generateLaunchJsonCommand),
        vscode.commands.registerCommand('dotnetX86.gettingStarted', () =>
            vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#dotnetX86.gettingStarted`, false)),
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
        dataBindings,
        // From a control: that control and the ones inside it; from the view title or the Command Palette: every open form.
        vscode.commands.registerCommand('dotnetX86.showDataBindings', (node?: ControlNode) => dataBindings.show(node)),
        exceptionLog,
        exceptionView,
        vscode.commands.registerCommand('dotnetX86.clearExceptionLog', () => exceptionLog.clear()),
        evidence,
        vscode.commands.registerCommand('dotnetX86.captureEvidence', () => evidence.capture()),
        eventTrace,
        eventTraceView,
        vscode.commands.registerCommand('dotnetX86.traceControlEvents', (node?: ControlNode) => controlTree.traceEvents(node ?? controlView.selection[0])),
        vscode.commands.registerCommand('dotnetX86.clearEventTrace', () => eventTrace.clear()),
        vscode.commands.registerCommand('dotnetX86.exportEventTrace', () => eventTrace.export()),
        sqlLog,
        sqlView,
        vscode.commands.registerCommand('dotnetX86.clearSqlLog', () => sqlLog.clear()),
        vscode.commands.registerCommand('dotnetX86.exportSqlLog', () => sqlLog.export()),
        vscode.commands.registerCommand('dotnetX86.copySqlWithValues', (entry) => sqlLog.copy(entry, true)),
        vscode.commands.registerCommand('dotnetX86.copySql', (entry) => sqlLog.copy(entry, false)),
        vscode.commands.registerCommand('dotnetX86.openSql', (entry) => sqlLog.open(entry)),
        exceptionSettings,
        exceptionSettingsView,
        vscode.commands.registerCommand('dotnetX86.addExceptionType', () => exceptionSettings.addType()),
        vscode.commands.registerCommand('dotnetX86.removeExceptionType', (node) => exceptionSettings.removeType(node)),
        vscode.commands.registerCommand('dotnetX86.uncheckExceptionTypes', () => exceptionSettings.uncheckAll()),
        vscode.commands.registerCommand('dotnetX86.breakOnExceptionType', (entry?: { typeName?: string }) => entry?.typeName && exceptionSettings.addType(entry.typeName)),
        sessionReport,
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, sessionReport),
        vscode.commands.registerCommand('dotnetX86.exportSessionReport', () => sessionReport.export()),
        mcp,
        vscode.commands.registerCommand('dotnetX86.copyMcpConnectionSettings', () => mcp.copyConnectionSettings()),
        vscode.commands.registerCommand('dotnetX86.registerMcpServer', () => mcp.registerWithClients()),
        editAndContinue,
        vscode.commands.registerCommand('dotnetX86.applyCodeChanges', () => editAndContinue.applyCommand()),
    );
}

export function deactivate(): void {}

/**
 * Deletes the symbols and sources the removed ILSpy helper wrote (`<globalStorage>/decompiled`). They would no longer be
 * loaded, and the engine decompiles assemblies without symbols itself.
 */
function removeOldDecompiledCache(folder: string, output: vscode.OutputChannel): void {
    if (!fs.existsSync(folder)) {
        return;
    }
    try {
        fs.rmSync(folder, { recursive: true, force: true });
        output.appendLine(`[decompiler] removed the symbols of the former Decompile for Debugging: ${folder}`);
    } catch (e) {
        output.appendLine(`[decompiler] could not remove ${folder}: ${e instanceof Error ? e.message : String(e)}`);
    }
}