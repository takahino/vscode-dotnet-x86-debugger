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
import { CoverageHighlighter } from './coverage';
import { PinnedValues } from './pinnedValues';
import { ModuleList, copyModulePath, revealModule } from './moduleList';
import { McpIntegration } from './mcp';
import { makeObjectIdCommand } from './objectIdCommand';
import { SessionReport } from './sessionReport';
import { EventTrace } from './eventTrace';
import { EvidenceCapture } from './evidence';
import { SqlLog } from './sqlLog';
import { JournalView } from './journalView';
import { StepHistory } from './stepHistory';
import { SymbolServer } from './symbolServer';
import { generateTestCommand } from './testGenerator';
import { viewAsImageCommand } from './imageVisualizer';
import { viewAsTableCommand } from './tableVisualizer';
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
    const output = vscode.window.createOutputChannel('netdbg');
    const snapshots = new SnapshotStore();
    const memory = new MemoryMonitor(context.extensionPath, output);
    const valueTracker = new ValueTracker();
    const stepHistory = new StepHistory();
    const moduleList = new ModuleList();
    const perfTips = new PerfTips();
    const coverage = new CoverageHighlighter();
    const autos = new AutosView();
    const breakpointCommands = new BreakpointCommands();
    const pinnedValues = new PinnedValues(context.workspaceState);
    const controlTree = new ControlTree();
    const controlView = vscode.window.createTreeView('netdbg.controls', { treeDataProvider: controlTree });
    controlTree.attach(controlView);
    const highlighter = new WindowHighlighter(context.extensionPath, (line) => output.appendLine(line));
    const dataBindings = new DataBindingsPanel((node) => controlTree.highlight(node, highlighter));
    const exceptionLog = new ExceptionLog();
    const exceptionView = vscode.window.createTreeView('netdbg.exceptions', { treeDataProvider: exceptionLog });
    exceptionLog.attach(exceptionView);
    const eventTrace = new EventTrace();
    const eventTraceView = vscode.window.createTreeView('netdbg.eventTrace', { treeDataProvider: eventTrace });
    eventTrace.attach(eventTraceView);
    const sqlLog = new SqlLog();
    const evidence = new EvidenceCapture(context.extensionPath, sqlLog, (line) => output.appendLine(line));
    const sqlView = vscode.window.createTreeView('netdbg.sqlLog', { treeDataProvider: sqlLog });
    sqlLog.attach(sqlView);
    const journalView = new JournalView();
    const recordsView = vscode.window.createTreeView('netdbg.records', { treeDataProvider: journalView });
    journalView.attach(recordsView);
    const exceptionSettings = new ExceptionSettings(context.workspaceState);
    const exceptionSettingsView = vscode.window.createTreeView('netdbg.exceptionSettings', { treeDataProvider: exceptionSettings, manageCheckboxStateManually: true });
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
        vscode.commands.registerCommand('netdbg.pickProcess', pickProcess),
        vscode.commands.registerCommand('netdbg.dumpVariable', dumpVariableCommand),
        vscode.commands.registerCommand('netdbg.dumpExpression', dumpExpressionCommand),
        vscode.commands.registerCommand('netdbg.copyAsCSharp', copyAsCSharpCommand),
        vscode.commands.registerCommand('netdbg.makeObjectId', makeObjectIdCommand),
        vscode.commands.registerCommand('netdbg.generateTest', generateTestCommand),

        parallelStacks,
        vscode.commands.registerCommand('netdbg.showParallelStacks', () => parallelStacks.show()),
        vscode.commands.registerCommand('netdbg.freezeThread', (arg?: { threadId?: number; sessionId?: string }) => parallelStacks.setFrozen(arg, true)),
        heapSnapshots,
        environmentCheck,
        vscode.commands.registerCommand('netdbg.checkEnvironment', () => environmentCheck.show()),
        vscode.commands.registerCommand('netdbg.generateLaunchJson', generateLaunchJsonCommand),
        vscode.commands.registerCommand('netdbg.gettingStarted', () =>
            vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#netdbg.gettingStarted`, false)),
        vscode.commands.registerCommand('netdbg.showHeapSnapshots', () => heapSnapshots.show()),
        vscode.commands.registerCommand('netdbg.takeHeapSnapshot', () => heapSnapshots.take()),
        vscode.commands.registerCommand('netdbg.thawThread', (arg?: { threadId?: number; sessionId?: string }) => parallelStacks.setFrozen(arg, false)),
        vscode.commands.registerCommand('netdbg.downloadSymbols', (module?: { name?: string; path?: string }) => symbolServer.download(module)),
        vscode.commands.registerCommand('netdbg.clearDownloadedSymbols', () => symbolServer.clearCache()),
        vscode.commands.registerCommand('netdbg.viewString', viewStringCommand),
        vscode.commands.registerCommand('netdbg.takeSnapshot', (arg) => takeSnapshotCommand(snapshots, arg)),
        vscode.commands.registerCommand('netdbg.compareWithSnapshot', (arg) => compareWithSnapshotCommand(snapshots, arg)),
        vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshots),
        memory,
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, memory),
        vscode.commands.registerCommand('netdbg.showMemoryGraph', () => memory.show()),
        vscode.languages.registerInlineValuesProvider('csharp', new CSharpInlineValuesProvider()),
        valueTracker,
        vscode.commands.registerCommand('netdbg.trackValue', () => valueTracker.addTracker()),
        vscode.commands.registerCommand('netdbg.showValueTrend', () => valueTracker.show()),
        vscode.commands.registerCommand('netdbg.startTimer', () => valueTracker.addTimerStart()),
        vscode.commands.registerCommand('netdbg.endTimer', () => valueTracker.addTimerEnd()),
        stepHistory,
        vscode.window.createTreeView('netdbg.stepHistory', { treeDataProvider: stepHistory }),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, stepHistory),
        vscode.commands.registerCommand('netdbg.clearStepHistory', () => stepHistory.clear()),
        vscode.commands.registerCommand('netdbg.viewAsTable', viewAsTableCommand),
        vscode.commands.registerCommand('netdbg.viewAsImage', viewAsImageCommand),
        moduleList,
        vscode.window.createTreeView('netdbg.modules', { treeDataProvider: moduleList }),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, moduleList),
        vscode.commands.registerCommand('netdbg.copyModulePath', copyModulePath),
        vscode.commands.registerCommand('netdbg.revealModule', revealModule),
        perfTips,
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, perfTips),
        coverage,
        autos,
        vscode.window.createTreeView('netdbg.autos', { treeDataProvider: autos }),
        breakpointCommands,
        vscode.commands.registerCommand('netdbg.addTemporaryBreakpoint', () => breakpointCommands.addTemporary()),
        vscode.commands.registerCommand('netdbg.addDependentBreakpoint', () => breakpointCommands.addDependent()),
        vscode.commands.registerCommand('netdbg.addWhenChangedBreakpoint', () => breakpointCommands.addWhenChanged()),
        vscode.commands.registerCommand('netdbg.addCallerBreakpoint', () => breakpointCommands.addCallerFiltered()),
        pinnedValues,
        vscode.commands.registerCommand('netdbg.pinValue', () => pinnedValues.pin()),
        vscode.commands.registerCommand('netdbg.unpinValue', () => pinnedValues.unpin()),
        vscode.commands.registerCommand('netdbg.clearPinnedValues', () => pinnedValues.clear()),
        controlTree,
        controlView,
        vscode.commands.registerCommand('netdbg.refreshControlTree', () => controlTree.refresh()),
        vscode.commands.registerCommand('netdbg.dumpControl', (node: ControlNode) => dumpExpressionCommand(node?.expression)),
        highlighter,
        vscode.commands.registerCommand('netdbg.breakOnControlEvent', (node?: ControlNode) => controlTree.breakOnEvent(node ?? controlView.selection[0])),
        vscode.commands.registerCommand('netdbg.editControlProperty', (node?: ControlNode) => controlTree.editProperty(node ?? controlView.selection[0])),
        vscode.commands.registerCommand('netdbg.highlightControl', (node?: ControlNode) => controlTree.highlight(node ?? controlView.selection[0], highlighter)),
        vscode.commands.registerCommand('netdbg.copyControlExpression', (node: ControlNode) => node && vscode.env.clipboard.writeText(node.expression)),
        dataBindings,
        // From a control: that control and the ones inside it; from the view title or the Command Palette: every open form.
        vscode.commands.registerCommand('netdbg.showDataBindings', (node?: ControlNode) => dataBindings.show(node)),
        exceptionLog,
        exceptionView,
        vscode.commands.registerCommand('netdbg.clearExceptionLog', () => exceptionLog.clear()),
        evidence,
        vscode.commands.registerCommand('netdbg.captureEvidence', () => evidence.capture()),
        eventTrace,
        eventTraceView,
        vscode.commands.registerCommand('netdbg.traceControlEvents', (node?: ControlNode) => controlTree.traceEvents(node ?? controlView.selection[0])),
        vscode.commands.registerCommand('netdbg.clearEventTrace', () => eventTrace.clear()),
        vscode.commands.registerCommand('netdbg.exportEventTrace', () => eventTrace.export()),
        sqlLog,
        sqlView,
        vscode.commands.registerCommand('netdbg.clearSqlLog', () => sqlLog.clear()),
        vscode.commands.registerCommand('netdbg.exportSqlLog', () => sqlLog.export()),
        vscode.commands.registerCommand('netdbg.copySqlWithValues', (entry) => sqlLog.copy(entry, true)),
        vscode.commands.registerCommand('netdbg.copySql', (entry) => sqlLog.copy(entry, false)),
        vscode.commands.registerCommand('netdbg.openSql', (entry) => sqlLog.open(entry)),
        journalView,
        recordsView,
        vscode.commands.registerCommand('netdbg.clearRecords', () => journalView.clear()),
        exceptionSettings,
        exceptionSettingsView,
        vscode.commands.registerCommand('netdbg.addExceptionType', () => exceptionSettings.addType()),
        vscode.commands.registerCommand('netdbg.removeExceptionType', (node) => exceptionSettings.removeType(node)),
        vscode.commands.registerCommand('netdbg.uncheckExceptionTypes', () => exceptionSettings.uncheckAll()),
        vscode.commands.registerCommand('netdbg.breakOnExceptionType', (entry?: { typeName?: string }) => entry?.typeName && exceptionSettings.addType(entry.typeName)),
        sessionReport,
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, sessionReport),
        vscode.commands.registerCommand('netdbg.exportSessionReport', () => sessionReport.export()),
        mcp,
        vscode.commands.registerCommand('netdbg.copyMcpConnectionSettings', () => mcp.copyConnectionSettings()),
        vscode.commands.registerCommand('netdbg.registerMcpServer', () => mcp.registerWithClients()),
        editAndContinue,
        vscode.commands.registerCommand('netdbg.applyCodeChanges', () => editAndContinue.applyCommand()),
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