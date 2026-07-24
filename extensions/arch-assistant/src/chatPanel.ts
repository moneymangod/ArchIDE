import * as vscode from 'vscode';
import { ArchCliBridge, ChatMessage, StreamToken } from './cliBridge';

export class ArchChatPanel implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'arch-assistant.chat';
	private view?: vscode.WebviewView;
	private messages: ChatMessage[] = [];
	private isStreaming = false;
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly bridge: ArchCliBridge
	) {}

	dispose() {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	reveal() {
		this.view?.show(true);
	}

	sendMessage(content: string) {
		this.messages.push({ role: 'user', content, timestamp: Date.now() });
		this.postToWebview({ type: 'user-message', content });
		this.streamResponse();
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};

		webviewView.webview.html = this.getHtml();

		webviewView.webview.onDidReceiveMessage(async (message) => {
			switch (message.type) {
				case 'chat':
					if (this.isStreaming) {
						this.bridge.cancelCurrentRequest();
						this.isStreaming = false;
					}
					this.sendMessage(message.content);
					break;
				case 'cancel':
					this.bridge.cancelCurrentRequest();
					this.isStreaming = false;
					this.postToWebview({ type: 'stream-cancelled' });
					break;
				case 'apply-diff':
					await this.applyDiff(message.filePath, message.original, message.replacement);
					break;
				case 'insert-code':
					await this.insertCode(message.content);
					break;
				case 'mention-file':
					const fileContent = await this.getFileContent(message.path);
					if (fileContent !== null) {
						this.postToWebview({ type: 'file-context', path: message.path, content: fileContent });
					}
					break;
			}
		});
	}

	private async streamResponse() {
		this.isStreaming = true;
		this.postToWebview({ type: 'stream-start' });

		let fullContent = '';

		try {
			for await (const token of this.bridge.streamChat(this.messages)) {
				if (!this.isStreaming) break;

				switch (token.type) {
					case 'token':
						fullContent += token.content;
						this.postToWebview({ type: 'stream-token', content: token.content });
						break;
					case 'diff':
						this.postToWebview({
							type: 'diff-proposal',
							filePath: token.filePath,
							original: token.original,
							replacement: token.replacement
						});
						break;
					case 'error':
						this.postToWebview({ type: 'error', content: token.content });
						break;
					case 'done':
						break;
				}
			}
		} catch (err: any) {
			this.postToWebview({ type: 'error', content: err.message });
		}

		if (fullContent) {
			this.messages.push({ role: 'assistant', content: fullContent, timestamp: Date.now() });
		}

		this.isStreaming = false;
		this.postToWebview({ type: 'stream-end' });
	}

	private async applyDiff(filePath: string, original: string, replacement: string) {
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceRoot) return;

			const fullPath = vscode.Uri.file(
				filePath.startsWith('/') ? filePath : `${workspaceRoot}/${filePath}`
			);
			const doc = await vscode.workspace.openTextDocument(fullPath);
			const editor = await vscode.window.showTextDocument(doc);

			const text = doc.getText();
			const idx = text.indexOf(original);
			if (idx === -1) {
				vscode.window.showErrorMessage('Could not find original code in file');
				return;
			}

			const start = doc.positionAt(idx);
			const end = doc.positionAt(idx + original.length);
			const range = new vscode.Range(start, end);

			await editor.edit(editBuilder => {
				editBuilder.replace(range, replacement);
			});

			vscode.window.showInformationMessage(`Applied edit to ${filePath}`);
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to apply edit: ${err.message}`);
		}
	}

	private async insertCode(content: string) {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		await editor.edit(editBuilder => {
			editBuilder.insert(editor.selection.active, content);
		});
	}

	private async getFileContent(filePath: string): Promise<string | null> {
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceRoot) return null;

			const fullPath = vscode.Uri.file(
				filePath.startsWith('/') ? filePath : `${workspaceRoot}/${filePath}`
			);
			const doc = await vscode.workspace.openTextDocument(fullPath);
			return doc.getText();
		} catch {
			return null;
		}
	}

	private postToWebview(message: any) {
		this.view?.webview.postMessage(message);
	}

	private getHtml(): string {
		const nonce = getNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Arch Assistant</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
			height: 100vh;
			display: flex;
			flex-direction: column;
		}
		.messages {
			flex: 1;
			overflow-y: auto;
			padding: 12px;
		}
		.message {
			margin-bottom: 12px;
			padding: 8px 12px;
			border-radius: 8px;
			max-width: 95%;
			word-wrap: break-word;
			white-space: pre-wrap;
			font-size: 13px;
			line-height: 1.5;
		}
		.message.user {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			margin-left: auto;
			border-bottom-right-radius: 2px;
		}
		.message.assistant {
			background: var(--vscode-editor-inactiveSelectionBackground);
			border-bottom-left-radius: 2px;
		}
		.message.error {
			background: var(--vscode-inputValidation-errorBackground);
			color: var(--vscode-errorForeground);
			border: 1px solid var(--vscode-inputValidation-errorBorder);
		}
		.diff-proposal {
			margin: 8px 0;
			border: 1px solid var(--vscode-diffEditor-insertedTextBackground);
			border-radius: 6px;
			overflow: hidden;
		}
		.diff-header {
			padding: 6px 10px;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			font-size: 12px;
			font-weight: 600;
			border-bottom: 1px solid var(--vscode-divider-border);
		}
		.diff-content {
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
			padding: 8px;
			overflow-x: auto;
		}
		.diff-line removed { color: var(--vscode-diffEditor-removedTextBackground); background: rgba(255,0,0,0.1); display: block; }
		.diff-line added { color: var(--vscode-diffEditor-insertedTextBackground); background: rgba(0,255,0,0.1); display: block; }
		.diff-actions {
			padding: 6px 10px;
			display: flex;
			gap: 8px;
			border-top: 1px solid var(--vscode-divider-border);
		}
		.diff-actions button {
			padding: 4px 12px;
			border: none;
			border-radius: 4px;
			cursor: pointer;
			font-size: 12px;
		}
		.diff-actions .accept {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.diff-actions .reject {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		.input-area {
			padding: 8px 12px;
			border-top: 1px solid var(--vscode-divider-border);
			display: flex;
			gap: 8px;
		}
		.input-area textarea {
			flex: 1;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 6px;
			padding: 8px;
			font-family: var(--vscode-font-family);
			font-size: 13px;
			resize: none;
			min-height: 40px;
			max-height: 120px;
		}
		.input-area textarea:focus {
			outline: 1px solid var(--vscode-focusBorder);
		}
		.input-area button {
			padding: 8px 16px;
			border: none;
			border-radius: 6px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			cursor: pointer;
			font-size: 13px;
			align-self: flex-end;
		}
		.input-area button:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		.typing-indicator {
			padding: 8px 12px;
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			display: none;
		}
		@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
		.typing-indicator.active { display: block; animation: pulse 1.5s infinite; }
		code {
			background: var(--vscode-textCodeBlock-background);
			padding: 1px 4px;
			border-radius: 3px;
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
		}
		pre {
			background: var(--vscode-textCodeBlock-background);
			padding: 8px;
			border-radius: 4px;
			overflow-x: auto;
			margin: 4px 0;
		}
		pre code { padding: 0; background: none; }
	</style>
</head>
<body>
	<div class="messages" id="messages"></div>
	<div class="typing-indicator" id="typing">Arch is thinking...</div>
	<div class="input-area">
		<textarea id="input" placeholder="Ask Arch anything... (@ to mention files)" rows="1"></textarea>
		<button id="send" onclick="send()">Send</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const messagesEl = document.getElementById('messages');
		const inputEl = document.getElementById('input');
		const typingEl = document.getElementById('typing');
		const sendBtn = document.getElementById('send');
		let streaming = false;
		let currentStreamEl = null;

		inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				send();
			}
		});

		inputEl.addEventListener('input', () => {
			inputEl.style.height = 'auto';
			inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
		});

		function send() {
			const text = inputEl.value.trim();
			if (!text || streaming) return;
			vscode.postMessage({ type: 'chat', content: text });
			inputEl.value = '';
			inputEl.style.height = 'auto';
		}

		function addMessage(role, content) {
			const div = document.createElement('div');
			div.className = 'message ' + role;
			div.innerHTML = renderMarkdown(content);
			messagesEl.appendChild(div);
			messagesEl.scrollTop = messagesEl.scrollHeight;
			return div;
		}

		function renderMarkdown(text) {
			return text
				.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
				.replace(/\`([^\`]+)\`/g, '<code>$1</code>')
				.replace(/\\n/g, '<br>');
		}

		function showDiffProposal(filePath, original, replacement) {
			const div = document.createElement('div');
			div.className = 'diff-proposal';
			const origLines = original.split('\\n');
			const replLines = replacement.split('\\n');
			let diffHtml = '';
			const maxLines = Math.max(origLines.length, replLines.length);
			for (let i = 0; i < maxLines; i++) {
				if (i < origLines.length && (i >= replLines.length || origLines[i] !== replLines[i])) {
					diffHtml += '<span class="diff-line removed">- ' + escapeHtml(origLines[i]) + '</span>';
				}
				if (i < replLines.length && (i >= origLines.length || origLines[i] !== replLines[i])) {
					diffHtml += '<span class="diff-line added">+ ' + escapeHtml(replLines[i]) + '</span>';
				}
			}
			div.innerHTML = 
				'<div class="diff-header">' + escapeHtml(filePath) + '</div>' +
				'<div class="diff-content"><pre>' + diffHtml + '</pre></div>' +
				'<div class="diff-actions">' +
				'<button class="accept" onclick="applyDiff(this)" data-file="' + escapeHtml(filePath) + '" data-orig="' + escapeHtml(original) + '" data-repl="' + escapeHtml(replacement) + '">Apply</button>' +
				'<button class="reject" onclick="this.closest(\\'.diff-proposal\\').remove()">Reject</button>' +
				'</div>';
			messagesEl.appendChild(div);
			messagesEl.scrollTop = messagesEl.scrollHeight;
		}

		function applyDiff(btn) {
			vscode.postMessage({
				type: 'apply-diff',
				filePath: btn.dataset.file,
				original: btn.dataset.orig,
				replacement: btn.dataset.repl
			});
			btn.closest('.diff-proposal').querySelector('.diff-actions').innerHTML = '<span style="color:var(--vscode-terminal-ansiGreen)">Applied!</span>';
		}

		function escapeHtml(text) {
			const div = document.createElement('div');
			div.textContent = text;
			return div.innerHTML;
		}

		window.addEventListener('message', (event) => {
			const msg = event.data;
			switch (msg.type) {
				case 'user-message':
					addMessage('user', msg.content);
					break;
				case 'stream-start':
					streaming = true;
					sendBtn.disabled = true;
					sendBtn.textContent = 'Stop';
					sendBtn.onclick = () => vscode.postMessage({ type: 'cancel' });
					typingEl.classList.add('active');
					currentStreamEl = addMessage('assistant', '');
					break;
				case 'stream-token':
					if (currentStreamEl) {
						currentStreamEl.innerHTML = renderMarkdown(
							currentStreamEl.textContent + msg.content
						);
						messagesEl.scrollTop = messagesEl.scrollHeight;
					}
					break;
				case 'stream-end':
					streaming = false;
					sendBtn.disabled = false;
					sendBtn.textContent = 'Send';
					sendBtn.onclick = send;
					typingEl.classList.remove('active');
					currentStreamEl = null;
					break;
				case 'stream-cancelled':
					streaming = false;
					sendBtn.disabled = false;
					sendBtn.textContent = 'Send';
					sendBtn.onclick = send;
					typingEl.classList.remove('active');
					break;
				case 'diff-proposal':
					showDiffProposal(msg.filePath, msg.original, msg.replacement);
					break;
				case 'error':
					addMessage('error', msg.content);
					break;
				case 'file-context':
					addMessage('assistant', 'Loaded context from ' + msg.path + ' (' + msg.content.length + ' chars)');
					break;
			}
		});
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
