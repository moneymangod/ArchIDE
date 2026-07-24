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
				case 'switch-model':
					this.bridge.switchModel(message.model);
					this.postToWebview({ type: 'model-switched', model: message.model });
					break;
				case 'clear-chat':
					this.messages = [];
					this.postToWebview({ type: 'chat-cleared' });
					break;
				case 'open-terminal':
					vscode.commands.executeCommand('workbench.action.terminal.new');
					vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
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
		const config = this.bridge.getConfig();
		const models = config.models || {};
		const currentModel = models.chat || 'oc/big-pickle';
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
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			font-size: 13px;
			color: #e0e0e0;
			background: #1a1a2e;
			height: 100vh;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.header {
			padding: 12px 16px;
			background: #16213e;
			border-bottom: 1px solid #2a2a4a;
			display: flex;
			align-items: center;
			gap: 10px;
		}
		.header .logo {
			font-size: 18px;
			font-weight: 700;
			color: #00d4ff;
			letter-spacing: -0.5px;
		}
		.header .model-badge {
			background: #0f3460;
			color: #00d4ff;
			padding: 4px 10px;
			border-radius: 12px;
			font-size: 11px;
			font-weight: 600;
			border: 1px solid #00d4ff33;
			flex: 1;
			text-align: center;
		}
		.header .model-select {
			background: #0f3460;
			color: #00d4ff;
			border: 1px solid #00d4ff44;
			border-radius: 8px;
			padding: 6px 12px;
			font-size: 12px;
			cursor: pointer;
			outline: none;
			flex: 1;
		}
		.header .model-select:focus {
			border-color: #00d4ff;
		}
		.header .model-select option {
			background: #16213e;
			color: #e0e0e0;
		}
		.header .actions {
			display: flex;
			gap: 4px;
		}
		.header .actions button {
			background: transparent;
			border: 1px solid #2a2a4a;
			color: #888;
			cursor: pointer;
			padding: 6px 8px;
			border-radius: 6px;
			font-size: 14px;
			transition: all 0.15s;
		}
		.header .actions button:hover {
			background: #2a2a4a;
			color: #00d4ff;
			border-color: #00d4ff44;
		}
		.messages {
			flex: 1;
			overflow-y: auto;
			padding: 16px;
			display: flex;
			flex-direction: column;
			gap: 12px;
		}
		.message {
			padding: 12px 16px;
			border-radius: 12px;
			max-width: 92%;
			word-wrap: break-word;
			white-space: pre-wrap;
			font-size: 13px;
			line-height: 1.6;
			animation: fadeIn 0.15s ease-out;
		}
		@keyframes fadeIn {
			from { opacity: 0; transform: translateY(4px); }
			to { opacity: 1; transform: translateY(0); }
		}
		.message.user {
			background: #0f3460;
			color: #00d4ff;
			align-self: flex-end;
			border-bottom-right-radius: 4px;
			border: 1px solid #00d4ff33;
		}
		.message.assistant {
			background: #16213e;
			border-bottom-left-radius: 4px;
			border: 1px solid #2a2a4a;
		}
		.message.error {
			background: #3d1f1f;
			color: #ff6b6b;
			border: 1px solid #ff6b6b44;
		}
		.diff-proposal {
			margin: 8px 0;
			border: 1px solid #00d4ff;
			border-radius: 8px;
			overflow: hidden;
			background: #1a1a2e;
		}
		.diff-header {
			padding: 8px 12px;
			background: #16213e;
			font-size: 12px;
			font-weight: 600;
			border-bottom: 1px solid #2a2a4a;
			color: #00d4ff;
		}
		.diff-content {
			font-family: 'Cascadia Code', 'Fira Code', monospace;
			font-size: 12px;
			padding: 12px;
			overflow-x: auto;
			background: #1a1a2e;
		}
		.diff-line.removed {
			color: #ff6b6b;
			background: rgba(255, 107, 107, 0.1);
			display: block;
			padding: 2px 4px;
		}
		.diff-line.added {
			color: #00d4ff;
			background: rgba(0, 212, 255, 0.1);
			display: block;
			padding: 2px 4px;
		}
		.diff-actions {
			padding: 8px 12px;
			display: flex;
			gap: 8px;
			border-top: 1px solid #2a2a4a;
		}
		.diff-actions button {
			padding: 6px 16px;
			border: none;
			border-radius: 6px;
			cursor: pointer;
			font-size: 12px;
			font-weight: 500;
			transition: all 0.15s;
		}
		.diff-actions .accept {
			background: #00d4ff;
			color: #1a1a2e;
		}
		.diff-actions .accept:hover {
			background: #00b8d9;
		}
		.diff-actions .reject {
			background: #2a2a4a;
			color: #ccc;
		}
		.diff-actions .reject:hover {
			background: #3a3a5a;
		}
		.input-area {
			padding: 12px 16px;
			background: #16213e;
			border-top: 1px solid #2a2a4a;
		}
		.input-wrapper {
			display: flex;
			gap: 8px;
			align-items: flex-end;
		}
		.input-wrapper textarea {
			flex: 1;
			background: #1a1a2e;
			color: #e0e0e0;
			border: 1px solid #2a2a4a;
			border-radius: 8px;
			padding: 10px 14px;
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			font-size: 13px;
			resize: none;
			min-height: 42px;
			max-height: 150px;
			line-height: 1.4;
			outline: none;
		}
		.input-wrapper textarea:focus {
			border-color: #00d4ff;
		}
		.input-wrapper textarea::placeholder {
			color: #555;
		}
		.send-btn {
			width: 42px;
			height: 42px;
			border: none;
			border-radius: 8px;
			background: #00d4ff;
			color: #1a1a2e;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 18px;
			font-weight: bold;
			transition: all 0.15s;
			flex-shrink: 0;
		}
		.send-btn:hover {
			background: #00b8d9;
			transform: scale(1.05);
		}
		.send-btn:disabled {
			background: #2a2a4a;
			color: #555;
			cursor: not-allowed;
			transform: none;
		}
		.typing-indicator {
			padding: 8px 16px;
			font-size: 12px;
			color: #00d4ff;
			display: none;
			align-items: center;
			gap: 8px;
		}
		.typing-indicator.active {
			display: flex;
		}
		.typing-dots {
			display: flex;
			gap: 4px;
		}
		.typing-dots span {
			width: 6px;
			height: 6px;
			background: #00d4ff;
			border-radius: 50%;
			animation: bounce 1.4s infinite ease-in-out;
		}
		.typing-dots span:nth-child(1) { animation-delay: -0.32s; }
		.typing-dots span:nth-child(2) { animation-delay: -0.16s; }
		@keyframes bounce {
			0%, 80%, 100% { transform: scale(0); }
			40% { transform: scale(1); }
		}
		code {
			background: #1a1a2e;
			padding: 2px 6px;
			border-radius: 4px;
			font-family: 'Cascadia Code', 'Fira Code', monospace;
			font-size: 12px;
			border: 1px solid #2a2a4a;
			color: #00d4ff;
		}
		pre {
			background: #0f0f23;
			padding: 12px;
			border-radius: 6px;
			overflow-x: auto;
			margin: 8px 0;
			border: 1px solid #2a2a4a;
		}
		pre code {
			padding: 0;
			background: none;
			border: none;
			color: #e0e0e0;
		}
		.welcome {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			color: #555;
			text-align: center;
			padding: 24px;
		}
		.welcome .icon {
			font-size: 64px;
			margin-bottom: 16px;
			color: #00d4ff;
			opacity: 0.8;
		}
		.welcome h3 {
			color: #e0e0e0;
			margin-bottom: 8px;
			font-size: 20px;
			font-weight: 600;
		}
		.welcome p {
			font-size: 13px;
			line-height: 1.5;
			max-width: 280px;
		}
		.welcome .shortcuts {
			margin-top: 24px;
			padding: 16px;
			background: #16213e;
			border-radius: 10px;
			border: 1px solid #2a2a4a;
			text-align: left;
		}
		.welcome .shortcuts div {
			padding: 6px 0;
			font-size: 12px;
			color: #888;
		}
		.welcome .shortcuts kbd {
			background: #0f3460;
			padding: 3px 8px;
			border-radius: 4px;
			font-family: monospace;
			font-size: 11px;
			border: 1px solid #00d4ff33;
			color: #00d4ff;
			margin-right: 8px;
		}
	</style>
</head>
<body>
	<div class="header">
		<span class="logo">Arch</span>
		<select class="model-select" id="modelSelect">
			<option value="oc/big-pickle">oc/big-pickle</option>
			<option value="gemini/gemini-2.5-flash">gemini-2.5-flash</option>
			<option value="nvidia/minimaxai/minimax-m3">minimax-m3</option>
			<option value="nvidia/minimaxai/minimax-m2.7">minimax-m2.7</option>
			<option value="groq/openai/gpt-oss-120b">gpt-oss-120b</option>
			<option value="cf/@cf/moonshotai/kimi-k2.6">kimi-k2.6</option>
		</select>
		<div class="actions">
			<button id="terminalBtn" title="Open Terminal">Terminal</button>
			<button id="clearBtn" title="Clear chat">Clear</button>
		</div>
	</div>
	<div class="messages" id="messages">
		<div class="welcome">
			<div class="icon">Arch</div>
			<h3>Arch Assistant</h3>
			<p>Ask me anything about your code. I can edit, explain, fix, and more.</p>
			<div class="shortcuts">
				<div><kbd>Ctrl+Shift+E</kbd> Edit with AI</div>
				<div><kbd>Ctrl+Shift+A</kbd> Open Chat</div>
				<div><kbd>@filename</kbd> Mention a file</div>
				<div><kbd>Enter</kbd> Send message</div>
				<div><kbd>Shift+Enter</kbd> New line</div>
			</div>
		</div>
	</div>
	<div class="typing-indicator" id="typing">
		<div class="typing-dots"><span></span><span></span><span></span></div>
		<span>Arch is thinking...</span>
	</div>
	<div class="input-area">
		<div class="input-wrapper">
			<textarea id="input" placeholder="Ask Arch anything..." rows="1"></textarea>
			<button class="send-btn" id="send" title="Send">Send</button>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const messagesEl = document.getElementById('messages');
		const inputEl = document.getElementById('input');
		const typingEl = document.getElementById('typing');
		const sendBtn = document.getElementById('send');
		const modelSelect = document.getElementById('modelSelect');
		const clearBtn = document.getElementById('clearBtn');
		const terminalBtn = document.getElementById('terminalBtn');
		let streaming = false;
		let currentStreamEl = null;
		let hasWelcomed = false;

		modelSelect.addEventListener('change', () => {
			vscode.postMessage({ type: 'switch-model', model: modelSelect.value });
		});

		clearBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'clear-chat' });
		});

		terminalBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'open-terminal' });
		});

		inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				send();
			}
		});

		inputEl.addEventListener('input', () => {
			inputEl.style.height = 'auto';
			inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
		});

		function send() {
			const text = inputEl.value.trim();
			if (!text || streaming) return;

			if (!hasWelcomed) {
				const welcome = messagesEl.querySelector('.welcome');
				if (welcome) welcome.remove();
				hasWelcomed = true;
			}

			vscode.postMessage({ type: 'chat', content: text });
			inputEl.value = '';
			inputEl.style.height = 'auto';
			inputEl.focus();
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
				.replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
				.replace(/\`([^\`]+)\`/g, '<code>$1</code>')
				.replace(/\n/g, '<br>');
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
			btn.closest('.diff-proposal').querySelector('.diff-actions').innerHTML = '<span style="color:#00d4ff">Applied!</span>';
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
				case 'model-switched':
					addMessage('assistant', 'Switched to ' + msg.model);
					break;
				case 'chat-cleared':
					messagesEl.innerHTML = '';
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
