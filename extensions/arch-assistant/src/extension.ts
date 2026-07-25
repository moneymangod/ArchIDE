import * as vscode from 'vscode';

let archTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
	// Auto-open terminal with 'arch' on startup
	const config = loadConfig();
	const delay = config.autoOpenDelay || 500;

	setTimeout(async () => {
		// Set terminal to right side
		await vscode.workspace.getConfiguration().update(
			'workbench.sideBar.location',
			'right',
			vscode.ConfigurationTarget.Global
		);

		// Create terminal running arch
		archTerminal = vscode.window.createTerminal({
			name: 'Arch CLI',
			iconPath: new vscode.ThemeIcon('terminal'),
		});

		// Show the terminal
		archTerminal.show();

		// Run the arch command
		archTerminal.sendText('arch', true);
	}, delay);

	// Register command to open new arch terminal
	context.subscriptions.push(
		vscode.commands.registerCommand('arch-assistant.openTerminal', () => {
			const terminal = vscode.window.createTerminal({
				name: 'Arch CLI',
				iconPath: new vscode.ThemeIcon('terminal'),
			});
			terminal.show();
			terminal.sendText('arch', true);
			archTerminal = terminal;
		}),
	);

	// Keep terminal alive
	context.subscriptions.push(
		vscode.window.onDidCloseTerminal((terminal) => {
			if (terminal === archTerminal) {
				archTerminal = undefined;
			}
		}),
	);
}

function loadConfig() {
	const fs = require('fs');
	const path = require('path');
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
