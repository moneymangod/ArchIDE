import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let archTerminal: vscode.Terminal | undefined;

function findOpenCodeCommand(): string {
	const candidates = [
		path.join(process.env.USERPROFILE || '', 'Downloads', 'ArchCLI', 'opencode.bat'),
		path.join(process.env.USERPROFILE || '', 'Downloads', 'ArchCLI', 'opencode.cmd'),
	];

	for (const p of candidates) {
		if (fs.existsSync(p)) {
			return `"${p}"`;
		}
	}

	return 'opencode';
}

export function activate(context: vscode.ExtensionContext) {
	const cmd = findOpenCodeCommand();
	const config = loadConfig();
	const delay = config.autoOpenDelay || 500;

	setTimeout(() => {
		// Keep activity bar on left (default), open terminal on right panel
		archTerminal = vscode.window.createTerminal({
			name: 'OpenCode',
			iconPath: new vscode.ThemeIcon('terminal'),
			location: vscode.TerminalLocation.Panel,
		});
		archTerminal.show();
		archTerminal.sendText(cmd, true);
	}, delay);

	context.subscriptions.push(
		vscode.commands.registerCommand('arch-assistant.openTerminal', () => {
			const terminal = vscode.window.createTerminal({
				name: 'OpenCode',
				iconPath: new vscode.ThemeIcon('terminal'),
				location: vscode.TerminalLocation.Panel,
			});
			terminal.show();
			terminal.sendText(cmd, true);
			archTerminal = terminal;
		}),
	);

	context.subscriptions.push(
		vscode.window.onDidCloseTerminal((terminal) => {
			if (terminal === archTerminal) {
				archTerminal = undefined;
			}
		}),
	);
}

function loadConfig() {
	const globalConfigPath = path.join(
		process.env.USERPROFILE || process.env.HOME || '',
		'.archide', 'config.json'
	);

	let config: any = { autoOpenDelay: 500 };

	if (fs.existsSync(globalConfigPath)) {
		try {
			const raw = fs.readFileSync(globalConfigPath, 'utf8');
			config = { ...config, ...JSON.parse(raw) };
		} catch {}
	}

	return config;
}

export function deactivate() {}
