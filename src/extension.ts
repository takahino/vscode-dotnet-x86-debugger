import * as vscode from 'vscode';
import { X86AdapterFactory } from './adapterFactory';
import { DEBUG_TYPE, X86ConfigurationProvider } from './configProvider';
import { pickProcess } from './processPicker';

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('.NET x86 Debugger');

    context.subscriptions.push(
        output,
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new X86ConfigurationProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new X86AdapterFactory(context.extensionPath, output)),
        vscode.commands.registerCommand('dotnetX86.pickProcess', pickProcess),
    );
}

export function deactivate(): void {}
