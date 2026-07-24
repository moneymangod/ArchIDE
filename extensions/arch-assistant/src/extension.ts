import * as vscode from 'vscode';
import { ArchChatPanel } from './chatPanel';
import { ArchCliBridge } from './cliBridge';
import { InlineEditProvider } from './inlineEdit';

export function activate(context: vscode.ExtensionContext) {
	const bridge = new ArchCliBridge(context);
	const chatPanel = new ArchChatPanel(context.extensionUri, bridge);
	const inlineEdit = new InlineEditProvider(bridge);

	context.subscriptions.push(
		vscode.commands.registerCommand('arch-assistant.openChat', () => {
			chatPanel.reveal();
		}),
		vscode.commands.registerCommand('arch-assistant.editWithAI', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage('No active editor');
				return;
			}
			const selection = editor.document.getText(editor.selection);
			if (!selection) {
				vscode.window.showWarningMessage('Select code first');
				return;
			}
			const prompt = await vscode.window.showInputBox({
				prompt: 'How should I edit this code?',
				placeHolder: 'e.g. Add error handling, rename to camelCase, optimize for performance...'
			});
			if (!prompt) return;

			await inlineEdit.proposeEdit(editor, editor.selection, prompt);
		}),
		vscode.commands.registerCommand('arch-assistant.explainCode', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const selection = editor.document.getText(editor.selection);
			if (!selection) return;
			chatPanel.reveal();
			chatPanel.sendMessage(`Explain this code:\n\`\`\`\n${selection}\n\`\`\``);
		}),
		vscode.commands.registerCommand('arch-assistant.fixCode', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const selection = editor.document.getText(editor.selection);
			if (!selection) return;
			chatPanel.reveal();
			chatPanel.sendMessage(`Fix bugs in this code:\n\`\`\`\n${selection}\n\`\`\``);
		}),
		vscode.commands.registerCommand('arch-assistant.addToChat', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const selection = editor.document.getText(editor.selection);
			const fileName = vscode.workspace.asRelativePath(editor.document.fileName);
			if (!selection) return;
			chatPanel.reveal();
			chatPanel.sendMessage(`Context from ${fileName}:\n\`\`\`\n${selection}\n\`\`\``);
		}),
	);

	vscode.window.registerWebviewViewProvider('arch-assistant.chat', chatPanel, {
		webviewOptions: { retainContextWhenHidden: true }
	});

	// Auto-open the chat sidebar on startup
	setTimeout(() => {
		vscode.commands.executeCommand('workbench.view.extension.arch-assistant');
	}, 500);
}

export function deactivate() {}
