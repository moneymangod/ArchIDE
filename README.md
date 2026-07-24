# ArchIDE

An AI-native IDE fork of VS Code with integrated AI assistant powered by 9router/Cloudflare Workers AI.

## Features

- Full VS Code functionality
- Built-in AI chat sidebar (auto-opens on startup)
- Edit with AI (Ctrl+Shift+E)
- Explain Code / Fix Code context menu
- File context via @-mentions
- Streaming responses with diff proposals
- Supports any OpenAI-compatible API (9router, NVIDIA NIM, etc.)

## Setup

1. Install [VS C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (optional, for native modules)
2. Copy `config.example.json` to `~/.archide/config.json`
3. Edit `~/.archide/config.json` with your API keys
4. Run `ArchIDE.bat` or `VSCodium.exe --no-sandbox .`

## Configuration

Edit `~/.archide/config.json`:

```json
{
  "providers": {
    "9router": {
      "type": "openai",
      "baseUrl": "http://127.0.0.1:20128/v1",
      "apiKey": "your-key-here"
    }
  },
  "defaultProvider": "9router",
  "models": {
    "chat": "oc/big-pickle",
    "edit": "oc/big-pickle"
  }
}
```

## Building from Source

Requires VS Code build dependencies:
```bash
node --experimental-strip-types --experimental-transform-types build/next/index.ts transpile
node --experimental-strip-types --experimental-transform-types build/next/index.ts bundle --target desktop --out out-vscode
```

## License

MIT
