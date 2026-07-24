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
			color: var(--vscode-foreground);
			background: #1e1e1e;
			height: 100vh;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.header {
			padding: 12px 16px;
			background: #252526;
			border-bottom: 1px solid #333;
			display: flex;
			align-items: center;
			gap: 10px;
		}
		.header .logo {
			font-size: 16px;
			font-weight: 600;
			color: #fff;
		}
		.header .model-select {
			flex: 1;
			background: #333;
			color: #fff;
			border: 1px solid #444;
			border-radius: 6px;
			padding: 6px 10px;
			font-size: 12px;
			cursor: pointer;
			outline: none;
		}
		.header .model-select:focus {
			border-color: #007acc;
		}
		.header .clear-btn {
			background: transparent;
			border: none;
			color: #888;
			cursor: pointer;
			padding: 4px 8px;
			border-radius: 4px;
			font-size: 14px;
		}
		.header .clear-btn:hover {
			background: #333;
			color: #fff;
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
			max-width: 90%;
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
			background: #007acc;
			color: #fff;
			align-self: flex-end;
			border-bottom-right-radius: 4px;
		}
		.message.assistant {
			background: #2d2d2d;
			border-bottom-left-radius: 4px;
			border: 1px solid #333;
		}
		.message.error {
			background: #5a1d1d;
			color: #f48771;
			border: 1px solid #f48771;
		}
		.diff-proposal {
			margin: 8px 0;
			border: 1px solid #4ec9b0;
			border-radius: 8px;
			overflow: hidden;
			background: #1e1e1e;
		}
		.diff-header {
			padding: 8px 12px;
			background: #252526;
			font-size: 12px;
			font-weight: 600;
			border-bottom: 1px solid #333;
			color: #4ec9b0;
		}
		.diff-content {
			font-family: 'Cascadia Code', 'Fira Code', monospace;
			font-size: 12px;
			padding: 12px;
			overflow-x: auto;
			background: #1e1e1e;
		}
		.diff-line.removed {
			color: #f48771;
			background: rgba(244, 135, 113, 0.1);
			display: block;
			padding: 2px 4px;
		}
		.diff-line.added {
			color: #4ec9b0;
			background: rgba(78, 201, 176, 0.1);
			display: block;
			padding: 2px 4px;
		}
		.diff-actions {
			padding: 8px 12px;
			display: flex;
			gap: 8px;
			border-top: 1px solid #333;
		}
		.diff-actions button {
			padding: 6px 16px;
			border: none;
			border-radius: 6px;
			cursor: pointer;
			font-size: 12px;
			font-weight: 500;
			transition: background 0.15s;
		}
		.diff-actions .accept {
			background: #0e639c;
			color: #fff;
		}
		.diff-actions .accept:hover {
			background: #1177bb;
		}
		.diff-actions .reject {
			background: #333;
			color: #ccc;
		}
		.diff-actions .reject:hover {
			background: #444;
		}
		.input-area {
			padding: 12px 16px;
			background: #252526;
			border-top: 1px solid #333;
		}
		.input-wrapper {
			display: flex;
			gap: 8px;
			align-items: flex-end;
		}
		.input-wrapper textarea {
			flex: 1;
			background: #333;
			color: #fff;
			border: 1px solid #444;
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
			border-color: #007acc;
		}
		.input-wrapper textarea::placeholder {
			color: #666;
		}
		.send-btn {
			width: 42px;
			height: 42px;
			border: none;
			border-radius: 8px;
			background: #007acc;
			color: #fff;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 18px;
			transition: background 0.15s;
			flex-shrink: 0;
		}
		.send-btn:hover {
			background: #0098ff;
		}
		.send-btn:disabled {
			background: #333;
			color: #666;
			cursor: not-allowed;
		}
		.typing-indicator {
			padding: 8px 16px;
			font-size: 12px;
			color: #888;
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
			background: #007acc;
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
			background: #1e1e1e;
			padding: 2px 6px;
			border-radius: 4px;
			font-family: 'Cascadia Code', 'Fira Code', monospace;
			font-size: 12px;
			border: 1px solid #333;
		}
		pre {
			background: #1e1e1e;
			padding: 12px;
			border-radius: 6px;
			overflow-x: auto;
			margin: 8px 0;
			border: 1px solid #333;
		}
		pre code {
			padding: 0;
			background: none;
			border: none;
		}
		.welcome {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			color: #666;
			text-align: center;
			padding: 24px;
		}
		.welcome .icon {
			font-size: 48px;
			margin-bottom: 16px;
			opacity: 0.5;
		}
		.welcome h3 {
			color: #ccc;
			margin-bottom: 8px;
			font-size: 16px;
		}
		.welcome p {
			font-size: 13px;
			line-height: 1.5;
		}
		.welcome .shortcuts {
			margin-top: 20px;
			padding: 12px 16px;
			background: #252526;
			border-radius: 8px;
			border: 1px solid #333;
		}
		.welcome .shortcuts div {
			padding: 4px 0;
			font-size: 12px;
		}
		.welcome .shortcuts kbd {
			background: #333;
			padding: 2px 6px;
			border-radius: 4px;
			font-family: monospace;
			font-size: 11px;
			border: 1px solid #444;
		}
	</style>
</head>
<body>
	<div class="header">
		<span class="logo">Arch</span>
		<select class="model-select" id="modelSelect">
			<option value="oc/big-pickle">${currentModel === 'oc/big-pickle' ? 'oc/big-pickle' : currentModel}</option>
			<option value="gemini/gemini-2.5-flash">gemini-2.5-flash</option>
			<option value="nvidia/minimaxai/minimax-m3">minimax-m3</option>
			<option value="nvidia/minimaxai/minimax-m2.7">minimax-m2.7</option>
			<option value="groq/openai/gpt-oss-120b">gpt-oss-120b</option>
			<option value="cf/@cf/moonshotai/kimi-k2.6">kimi-k2.6</option>
		</select>
		<button class="clear-btn" id="clearBtn" title="Clear chat">Clear</button>
	</div>
	<div class="messages" id="messages">
		<div class="welcome">
			<div class="icon">Arch</div>
			<h3>Arch Assistant</h3>
			<p>Ask me anything about your code.</p>
			<div class="shortcuts">
				<div><kbd>Ctrl+Shift+E</kbd> Edit with AI</div>
				<div><kbd>Ctrl+Shift+A</kbd> Open Chat</div>
				<div><kbd>@filename</kbd> Mention a file</div>
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
		let streaming = false;
		let currentStreamEl = null;
		let hasWelcomed = false;

		modelSelect.addEventListener('change', () => {
			vscode.postMessage({ type: 'switch-model', model: modelSelect.value });
		});

		clearBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'clear-chat' });
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
			btn.closest('.diff-proposal').querySelector('.diff-actions').innerHTML = '<span style="color:#4ec9b0">Applied!</span>';
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
