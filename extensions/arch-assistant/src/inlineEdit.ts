import * as vscode from 'vscode';
import { ArchCliBridge, StreamToken } from './cliBridge';

export class InlineEditProvider {
	private activeEditor?: vscode.TextEditor;
	private decorationType?: vscode.TextEditorDecorationType;
	private previewDecoration?: vscode.TextEditorDecorationType;

	constructor(private bridge: ArchCliBridge) {
		this.previewDecoration = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
			overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedText'),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
	}

	async proposeEdit(
		editor: vscode.TextEditor,
		selection: vscode.Selection,
		prompt: string
	): Promise<void> {
		const original = editor.document.getText(selection);
		const fileName = vscode.workspace.asRelativePath(editor.document.fileName);
		const languageId = editor.document.languageId;

		// Show inline progress
		const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
		statusItem.text = '$(loading~spin) Arch is editing...';
		statusItem.show();

		let fullResponse = '';
		const messages = [
			{
				role: 'user' as const,
				content: `Edit this ${languageId} code from ${fileName}.\n\nInstruction: ${prompt}\n\nOriginal code:\n\`\`\`${languageId}\n${original}\n\`\`\`\n\nRespond with ONLY the replacement code in a code block. No explanation needed.`,
				timestamp: Date.now()
			}
		];

		try {
			for await (const token of this.bridge.streamChat(messages)) {
				if (token.type === 'token') {
					fullResponse += token.content;
				}
			}

			// Extract code from response
			const codeMatch = fullResponse.match(/```(?:\w+)?\n([\s\S]*?)```/);
			const replacement = codeMatch ? codeMatch[1].trim() : fullResponse.trim();

			if (!replacement || replacement === original) {
				statusItem.dispose();
				vscode.window.showInformationMessage('Arch: No changes suggested');
				return;
			}

			// Show preview decoration
			const decorations: vscode.DecorationOptions[] = [];
			decorations.push({
				range: selection,
				hoverMessage: new vscode.MarkdownString(`**Proposed edit:**\n\`\`\`\n${replacement}\n\`\`\``)
			});
			editor.setDecorations(this.previewDecoration!, decorations);

			// Ask user to accept/reject
			const action = await vscode.window.showInformationMessage(
				`Arch suggests changes to ${fileName}. Accept?`,
				'Accept',
				'Reject',
				'Show Diff'
			);

			editor.setDecorations(this.previewDecoration!, []);

			if (action === 'Accept') {
				await editor.edit(editBuilder => {
					editBuilder.replace(selection, replacement);
				});
				vscode.window.showInformationMessage('Edit applied');
			} else if (action === 'Show Diff') {
				await this.showDiff(editor.document, selection, original, replacement);
			}
		} catch (err: any) {
			vscode.window.showErrorMessage(`Arch edit failed: ${err.message}`);
		} finally {
			statusItem.dispose();
		}
	}

	private async showDiff(
		document: vscode.TextDocument,
		selection: vscode.Selection,
		original: string,
		replacement: string
	): Promise<void> {
		const originalUri = vscode.Uri.parse(`archide-diff:original/${vscode.workspace.asRelativePath(document.fileName)}`);
		const revisedUri = vscode.Uri.parse(`archide-diff:revised/${vscode.workspace.asRelativePath(document.fileName)}`);

		// Create temp documents for diff
		const originalDoc = await vscode.workspace.openTextDocument({ content: original, language: document.languageId });
		const revisedDoc = await vscode.workspace.openTextDocument({ content: replacement, language: document.languageId });

		await vscode.commands.executeCommand('vscode.diff.openDiff', 
			originalDoc.uri, 
			revisedDoc.uri, 
			`${vscode.workspace.asRelativePath(document.fileName)} (Arch Edit)`
		);
	}

	dispose() {
		this.previewDecoration?.dispose();
	}
}
