import * as vscode from 'vscode';
import { X86AdapterFactory } from './adapterFactory';
import { DEBUG_TYPE, X86ConfigurationProvider } from './configProvider';
import { DapTraceFactory } from './dapTrace';
import { pickProcess } from './processPicker';
import { dumpExpressionCommand, dumpVariableCommand } from './variableDump';

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('.NET x86 Debugger');

    context.subscriptions.push(
        output,
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new X86ConfigurationProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new X86AdapterFactory(context.extensionPath, context.logUri.fsPath, output)),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, new DapTraceFactory(output)),
        vscode.commands.registerCommand('dotnetX86.pickProcess', pickProcess),
        vscode.commands.registerCommand('dotnetX86.dumpVariable', dumpVariableCommand),
        vscode.commands.registerCommand('dotnetX86.dumpExpression', dumpExpressionCommand),
    );
}

export function deactivate(): void {}
