import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
}

export interface EditProposal {
	filePath: string;
	original: string;
	replacement: string;
	description: string;
}

export interface StreamToken {
	type: 'token' | 'diff' | 'error' | 'done';
	content: string;
	filePath?: string;
	original?: string;
	replacement?: string;
}

export class ArchCliBridge implements vscode.Disposable {
	private outputChannel: vscode.OutputChannel;
	private config: ReturnType<typeof ArchCliBridge.loadConfig>;
	private abortController: AbortController | null = null;

	constructor(private context: vscode.ExtensionContext) {
		this.outputChannel = vscode.window.createOutputChannel('Arch Assistant');
		this.config = ArchCliBridge.loadConfig();
	}

	static loadConfig() {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const globalConfigPath = path.join(
			globalThis.process?.env?.USERPROFILE || globalThis.process?.env?.HOME || '',
			'.archide', 'config.json'
		);
		const projectConfigPath = workspaceRoot
			? path.join(workspaceRoot, '.archide', 'config.json')
			: null;

		let config: any = {
			providers: {},
			defaultProvider: '9router',
			models: { chat: 'oc/big-pickle', edit: 'oc/big-pickle', autocomplete: 'oc/big-pickle' }
		};

		if (fs.existsSync(globalConfigPath)) {
			try {
				const raw = fs.readFileSync(globalConfigPath, 'utf8');
				config = { ...config, ...JSON.parse(raw) };
			} catch {}
		}

		if (projectConfigPath && fs.existsSync(projectConfigPath)) {
			try {
				const raw = fs.readFileSync(projectConfigPath, 'utf8');
				const projectConfig = JSON.parse(raw);
				config = { ...config, ...projectConfig };
				if (projectConfig.providers) {
					config.providers = { ...config.providers, ...projectConfig.providers };
				}
			} catch {}
		}

		return config;
	}

	getConfig() {
		return this.config;
	}

	async *streamChat(
		messages: ChatMessage[],
		onToken?: (token: StreamToken) => void
	): AsyncGenerator<StreamToken> {
		const config = this.config;
		const providerName = config.defaultProvider;
		const provider = config.providers[providerName];

		if (!provider) {
			yield { type: 'error', content: `No provider configured for "${providerName}"` };
			return;
		}

		const systemPrompt = this.buildSystemPrompt();
		const model = config.models?.chat || 'oc/big-pickle';

		const apiMessages = [
			{ role: 'system', content: systemPrompt },
			...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
		];

		let url: string;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };

		if (provider.type === 'cloudflare') {
			url = `${provider.baseUrl || 'https://api.cloudflare.com/client/v4'}/accounts/${provider.accountId}/ai/v1/chat/completions`;
			headers['Authorization'] = `Bearer ${provider.apiKey}`;
		} else {
			// OpenAI-compatible (9router, NVIDIA NIM, etc.)
			const baseUrl = (provider.baseUrl || 'http://127.0.0.1:20128/v1').replace(/\/+$/, '');
			url = `${baseUrl}/chat/completions`;
			if (provider.apiKey) {
				headers['Authorization'] = `Bearer ${provider.apiKey}`;
			}
		}

		this.abortController = new AbortController();

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					model,
					messages: apiMessages,
					stream: true,
					max_tokens: 4096,
				}),
				signal: this.abortController.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				yield { type: 'error', content: `API error ${response.status}: ${errorText}` };
				return;
			}

			const reader = response.body?.getReader();
			if (!reader) {
				yield { type: 'error', content: 'No response body' };
				return;
			}

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith('data: ')) continue;
					const data = trimmed.slice(6);
					if (data === '[DONE]') continue;

					try {
						const parsed = JSON.parse(data);
						const content = parsed.choices?.[0]?.delta?.content;
						if (content) {
							const token: StreamToken = { type: 'token', content };
							yield token;
							onToken?.(token);
						}
					} catch {}
				}
			}
		} catch (err: any) {
			if (err.name === 'AbortError') {
				yield { type: 'error', content: 'Request cancelled' };
			} else {
				yield { type: 'error', content: `Connection error: ${err.message}` };
			}
		} finally {
			this.abortController = null;
		}

		yield { type: 'done', content: '' };
	}

	private buildSystemPrompt(): string {
		const config = this.config;
		const rules = config.rules || [];
		const basePrompt = `You are Arch Assistant, an AI coding helper integrated into ArchIDE. You help with coding tasks, explaining code, fixing bugs, and suggesting edits. When suggesting code edits, use this format:

\`\`\`diff
--- original
+++ replacement
\`\`\`

Be concise and helpful. When editing code, provide the full replacement block.`;

		if (rules.length > 0) {
			return `${basePrompt}\n\nAdditional rules:\n${rules.join('\n')}`;
		}
		return basePrompt;
	}

	cancelCurrentRequest() {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	dispose() {
		this.cancelCurrentRequest();
		this.outputChannel.dispose();
	}
}
