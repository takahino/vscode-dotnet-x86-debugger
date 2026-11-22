import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LaunchConfiguration, ProjectInfo, launchConfigurations, parseProject, projectIssues } from './projectSetupCore';

interface TaskDefinition {
    label: string;
    [key: string]: unknown;
}

/** The .csproj files of a workspace folder (build output and dependencies excluded). */
export async function findProjects(folder: vscode.WorkspaceFolder): Promise<ProjectInfo[]> {
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.csproj'), '**/{bin,obj,node_modules,.git}/**', 200);
    const projects: ProjectInfo[] = [];
    for (const uri of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
        try {
            projects.push(parseProject(uri.fsPath, fs.readFileSync(uri.fsPath, 'utf8')));
        } catch {
            // Unreadable project file: leave it out.
        }
    }
    return projects;
}

/**
 * Build tasks for the projects: one "build" task for the solution at the root (or the only project), else one per
 * executable project. Builds with -p:Platform=x86 so that AnyCPU dependencies build too and the output folder is known.
 */
async function buildTasks(folder: vscode.WorkspaceFolder, projects: ProjectInfo[]): Promise<{ tasks: TaskDefinition[]; taskFor: (p: ProjectInfo) => string }> {
    const task = (label: string, target: string): TaskDefinition => ({
        label, type: 'process', command: 'dotnet', args: ['build', target, '-p:Platform=x86'], group: 'build', problemMatcher: '$msCompile',
    });
    const rel = (file: string) => `\${workspaceFolder}/${path.relative(folder.uri.fsPath, file).replace(/\\/g, '/')}`;
    const solutions = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '*.{sln,slnx}'), undefined, 2)).map((u) => u.fsPath);
    const executables = projects.filter((p) => p.executable);
    if (solutions.length === 1 || executables.length <= 1) {
        const target = solutions.length === 1 ? rel(solutions[0]) : executables[0] ? rel(executables[0].file) : '${workspaceFolder}';
        return { tasks: [task('build', target)], taskFor: () => 'build' };
    }
    return { tasks: executables.map((p) => task(`build: ${p.name}`, rel(p.file))), taskFor: (p) => `build: ${p.name}` };
}

/**
 * The debug configurations for a folder's projects. Adds the build tasks they need to tasks.json (tasks with the same
 * label are kept as they are). Used for F5 without launch.json and for the Generate command.
 */
export async function configurationsForFolder(folder: vscode.WorkspaceFolder): Promise<{ configs: LaunchConfiguration[]; projects: ProjectInfo[] }> {
    const projects = await findProjects(folder);
    if (!projects.some((p) => p.executable)) {
        return { configs: [], projects };
    }
    const { tasks, taskFor } = await buildTasks(folder, projects);
    const tasksConfig = vscode.workspace.getConfiguration('tasks', folder.uri);
    const existing = tasksConfig.get<TaskDefinition[]>('tasks') ?? [];
    const missing = tasks.filter((t) => !existing.some((e) => e.label === t.label));
    if (missing.length) {
        if (!tasksConfig.get('version')) {
            await tasksConfig.update('version', '2.0.0', folderTarget());
        }
        await tasksConfig.update('tasks', [...existing, ...missing], folderTarget());
    }
    const configs = launchConfigurations(projects, folder.uri.fsPath, (f) => fs.existsSync(f), taskFor);
    return { configs, projects };
}

/** Command: writes launch.json (and the build task) for the projects of the workspace. */
export async function generateLaunchJsonCommand(): Promise<void> {
    const folder = await pickFolder();
    if (!folder) {
        return;
    }
    const { configs, projects } = await configurationsForFolder(folder);
    if (!configs.length) {
        void vscode.window.showWarningMessage(vscode.l10n.t('No executable C# project (.csproj with OutputType Exe or WinExe) was found in {0}.', folder.name));
        return;
    }
    const launch = vscode.workspace.getConfiguration('launch', folder.uri);
    const existing = launch.get<LaunchConfiguration[]>('configurations') ?? [];
    const added = configs.filter((c) => !existing.some((e) => e.name === c.name));
    if (added.length) {
        if (!launch.get('version')) {
            await launch.update('version', '0.2.0', folderTarget());
        }
        await launch.update('configurations', [...existing, ...added], folderTarget());
    }
    const file = vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');
    await vscode.window.showTextDocument(file);
    const message = added.length
        ? vscode.l10n.t('Added {0} debug configuration(s) to launch.json. Press F5 to build and start debugging.', added.length)
        : vscode.l10n.t('launch.json already has these configurations.');
    const needsFix = projects.some((p) => p.executable && projectIssues(p).length);
    const check = vscode.l10n.t('Check Environment');
    if (needsFix) {
        const pick = await vscode.window.showWarningMessage(`${message} ${vscode.l10n.t('Some projects need a change before they can be debugged as x86.')}`, check);
        if (pick === check) {
            await vscode.commands.executeCommand('netdbg.checkEnvironment');
        }
    } else {
        void vscode.window.showInformationMessage(message);
    }
}

/** .vscode/launch.json and tasks.json of the folder: "Workspace" in a single-folder window, "WorkspaceFolder" in a multi-root one. */
function folderTarget(): vscode.ConfigurationTarget {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
        void vscode.window.showWarningMessage(vscode.l10n.t('Open the folder of your project first (File > Open Folder).'));
        return undefined;
    }
    return folders.length === 1 ? folders[0] : vscode.window.showWorkspaceFolderPick();
}
