# PolyMCP Inspector Desktop (Tauri)

Desktop wrapper for PolyMCP Inspector, built with Tauri.

Version: 1.3.6

## What It Does

- starts local Inspector backend automatically
- opens native desktop window
- embeds Inspector UI with authenticated local session

## Install For Users (No Build Needed)

Download the package for your OS from GitHub Releases:

- Windows: `PolyMCP Inspector_*_x64-setup.exe` (or `.msi`)
- Ubuntu: `.deb` package (or AppImage if published)

Notes:
- Do not run `polymcp-inspector-backend.exe` directly (that is only the backend sidecar).
- Do not open `desktop-tauri/src/index.html` in a browser.

## Dev Run

From `polymcp-inspector/desktop-tauri`:

```bash
npm install
npm run tauri:dev
```

If Python backend package is not installed globally, set:

```bash
set POLYMCP_INSPECTOR_BACKEND=C:\path\to\polymcp-inspector-backend.exe
```

### Force TS backend (dev/source mode)

If you built `ts-backend/dist/server.js`, you can force desktop app to boot with the TypeScript backend:

```bash
set POLYMCP_INSPECTOR_BACKEND_MODE=ts
```

## Build Installer (Maintainers)

1) Build backend sidecar exe:

```powershell
cd polymcp-inspector
powershell -ExecutionPolicy Bypass -File .\scripts\build_backend_exe.ps1
# OR (TypeScript backend)
powershell -ExecutionPolicy Bypass -File .\scripts\build_backend_ts_exe.ps1
```

2) Build desktop app:

```bash
cd polymcp-inspector/desktop-tauri
npm install
npm run tauri:build
```

Installer output:
- `src-tauri/target/release/bundle/nsis/PolyMCP Inspector_*_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/PolyMCP Inspector_*_x64_en-US.msi`
- `src-tauri/target/release/bundle/deb/*.deb` (Linux)
- `src-tauri/target/release/bundle/appimage/*.AppImage` (Linux)
