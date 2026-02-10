<p align="center"> <img src="PolyMCP_inspector.png" alt="PolymCP Logo" width="700"/> </p>

Standalone inspector for MCP servers with UI preview and LLM-assisted tool orchestration.

Version: 1.3.6

## Features

- multi-server MCP support (HTTP and stdio)
- tools, resources, and prompts explorer
- MCP Apps UI preview with tool-call bridge
- chat playground with independent multi-tab sessions
- LLM orchestration: Ollama, OpenAI, Anthropic
- settings panel for Inspector/OpenAI/Claude API keys
- auto-tools routing (LLM decides if tools are needed)
- test suites, metrics, logs, export
- secure mode: API key, CORS allowlist, rate limiting

## Desktop Install (Recommended)

For normal users, install from GitHub Releases:

- Windows: `PolyMCP Inspector_*_x64-setup.exe` (or `.msi`)
- Ubuntu: `.deb` package (or AppImage if published)

No Python, Node, or manual build steps are required for end users.

## Python Install (Source/Dev)

```bash
pip install -e .
```

## Run (Source/Dev)

```bash
polymcp-inspector --host 127.0.0.1 --port 6274 --no-browser
```

Open:

```
http://127.0.0.1:6274/
```

## Secure Mode

```bash
polymcp-inspector --secure
# or
polymcp-inspector --secure --api-key "your-strong-key"
```

## LLM Providers

Set credentials using either method:

1) Settings tab in the Inspector UI (recommended):
   - Inspector API key (for secure mode)
   - OpenAI API key
   - Claude (Anthropic) API key
   - Keys are stored in browser localStorage for that Inspector UI
2) Environment variables:

```bash
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
```

The chat playground lets you pick provider and model per tab. Each tab keeps its own provider/model/server selection and conversation history.

When keys are configured in Settings, requests include `X-OpenAI-API-Key` and `X-Anthropic-API-Key` headers. Backend env vars are used as fallback.

URL query support:
- `?api_key=...`
- `?openai_api_key=...`
- `?anthropic_api_key=...`

## MCP Apps UI

If your server exposes HTML resources (`app://...`), the Inspector renders them inside chat as part of the assistant response. The latest UI is live and previous responses are snapshotted.

## Desktop App (Tauri)

This repo includes a desktop wrapper in `desktop-tauri/`.

Build steps (for maintainers):

1) Build backend sidecar exe (Windows):
   - `powershell -ExecutionPolicy Bypass -File .\scripts\build_backend_exe.ps1`
   - (Optional) choose Python explicitly: `powershell -ExecutionPolicy Bypass -File .\scripts\build_backend_exe.ps1 -PythonExe C:\Python312\python.exe`
   - TS backend sidecar alternative: `powershell -ExecutionPolicy Bypass -File .\scripts\build_backend_ts_exe.ps1`
   - (Optional) custom pkg targets: `powershell -ExecutionPolicy Bypass -File .\scripts\build_backend_ts_exe.ps1 -PkgTargets "node18-win-x64,node16-win-x64"`
2) Build installer:
   - `cd desktop-tauri`
   - `npm install`
   - `npm run tauri:build`
3) Publish installer artifacts:
   - `desktop-tauri/src-tauri/target/release/bundle/nsis/*.exe`
   - `desktop-tauri/src-tauri/target/release/bundle/msi/*.msi`

## TS Backend (Parity Migration)

The repo now includes an Inspector backend in TypeScript under `ts-backend/` with API-compatible routes used by the current UI.

Build and run backend:

```bash
cd ts-backend
npm install
npm run build
node dist/server.js --host 127.0.0.1 --port 6274 --secure --api-key test --verbose
```

To make desktop Tauri prefer TS backend in local/dev runs:

```bash
set POLYMCP_INSPECTOR_BACKEND_MODE=ts
```
