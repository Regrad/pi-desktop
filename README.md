# Pi Desktop

A portable Windows desktop app for the [Pi coding agent](https://github.com/earendil-works/pi), with projects, persistent chats, tools, plans, and local media generation.

Pi is built from the bundled source and integrated through its SDK. You do not need to install or launch a separate Pi application.

**[Download for Windows x64](https://github.com/Regrad/pi-desktop/releases/download/v0.1.0/Pi-Desktop-0.1.0-win-x64.zip)** · [Release notes and SHA-256 checksum](https://github.com/Regrad/pi-desktop/releases/tag/v0.1.0)

Extract the ZIP into a folder you can write to and run `app\Pi Desktop.exe`. No installer is required. The app creates its own `data` folder next to `app` on first launch. To update, close Pi Desktop and replace only `app`, keeping your existing `data` folder.

![Pi Desktop showing a project chat and completed work plan](docs/assets/pi-desktop.png)

*The screenshot uses a separate demo profile with fictional projects and conversation content. No personal chats or user data are included.*

## Features

- **Projects and chats:** multiple working folders, standalone chats, history search, archive, rename, and restore.
- **English and Russian UI:** English by default; switch instantly in **Settings → General → Interface language**. The choice persists across launches. Conversation content and the model's response language stay unchanged.
- **Local and remote models:** configure Pi providers or discover compatible local servers. Select the model and reasoning level in the chat toolbar.
- **Tools and progress:** live tool output, file diffs, elapsed time, and command timeout countdowns. Commands default to five minutes unless an explicit timeout overrides it.
- **Plans and goals:** editable work checklists, an optional read-only planning mode with implementation approval, and goals that continue across turns.
- **Notebook and skills:** keep useful facts per chat and manage reusable instructions for all projects or one project.
- **Built-in browser:** share tabs with the model, inspect pages, and download files into the chat's folder.
- **ComfyUI integration:** images, masks, music, voice, and 3D workflows, with image previews, audio playback, and an interactive GLB viewer.
- **Portable storage:** application files and user data are separate. Chats keep their original Pi session format.

## Getting started

The portable layout is:

```text
Pi Desktop/
  app/
    Pi Desktop.exe
  data/
```

Launch `app\Pi Desktop.exe`. To move the installation, copy the whole `Pi Desktop` folder. To update an existing installation, close the app and replace only `app`; keep the existing `data` folder.

Open **Settings → Models** to add a compatible local model server. Provider configuration is stored in `data\agent\models.json`. You can change the model and reasoning level before sending a message; selecting them does not send a request to the model.

Switching chats loads their visible history without starting a model request. Active chats can continue working in the background. Messages sent during a run are queued; the steering action sends a correction into the current run instead.

## Data and privacy

Everything below belongs to the portable installation:

| Path | Contents |
| --- | --- |
| `data/desktop-state.json` | Projects, chat index, and interface preferences |
| `data/agent/models.json` | Model and provider configuration |
| `data/agent/settings.json` | Pi settings |
| `data/agent/mcp-adapter.json` | Desktop MCP adapter configuration |
| `data/agent/mcp.json` | Native Pi MCP connections |
| `data/agent/APPEND_SYSTEM.md` | Global user instructions |
| `data/chats/<id>/sessions` | Original Pi JSONL history |
| `data/chats/<id>/workspace` | Standalone chat working files |
| `data/chats/<id>/chat-attachments` | Clipboard and uploaded attachments |
| `data/chats/<id>/downloads` | Browser downloads |
| `data/chats/<id>/*-generation` | Generated images, music, 3D, and video |
| `data/runtime` | Manually updated third-party npm add-ons |

External project folders and attached files remain references. Archiving keeps chat data; confirmed deletion moves the chat's own folder to the Windows Recycle Bin. It does not delete external project folders or files on the ComfyUI server.

Notebook entries are available to the model and are stored as plain text. The data folder can contain credentials and private conversation history; it is excluded from this source repository and should not be published.

## Plans, goals, and tools

A model can maintain a working checklist in normal chat mode. The separate **Plan** mode restricts work to exploration and preparing an implementation plan; implementation begins after approval.

Goals track progress across turns. Pausing a goal stops future automatic continuation while allowing the current response to finish. **Stop** interrupts the current response. Token limits can be set for a goal.

File diffs track edits attributed to the model's `write` and `edit` tools. Large files, binaries, and excluded build/dependency directories may not appear. Command side effects are not automatically attributed to the diff.

Images can be attached from files or the clipboard, opened in a zoomable preview, and copied with the image's right-click menu. Image input requires a model that supports it.

## ComfyUI

Start your ComfyUI server, then configure its address in **Settings → ComfyUI**. Install the models and custom nodes required by the workflows you use.

The bundled add-on provides dedicated tools for Qwen image generation and editing, SAM masks, YuE2 music, voice workflows, image-to-3D generation, texturing, and mesh processing. Its implementation lives under `resources/pi-comfyui/tools/`; the desktop app handles configuration and displays the results.

Results are stored in the corresponding chat folder. The interface supports image previews, audio playback, and textured, clay, or wireframe views of GLB models. Canceling a request removes its queued job; an already running generation may still finish in ComfyUI.

Custom workflows must be exported in ComfyUI's **API format**. Import only workflows and custom nodes you trust. Built-in workflows run locally; cloud API nodes are blocked by the add-on.

## Extensions and MCP

The app includes `pi-web-access`, `pi-tool-repair`, `pi-llama-cpp-stats`, `pi-mcp-adapter`, and `pi-lens`, plus local modules for loop protection, single-slot KV cache protection, and generation speed reporting.

Use **Settings → Modules** to manage built-in modules, add custom extensions, and check supported third-party updates. Pi itself is bundled and updated together with the application.

The computer-use MCP server is included and runs using the application's runtime. It does not require a separate global Node.js installation or `npx`. User-defined MCP connections remain configurable.

## Build from source

Development targets Windows x64. Use Node.js 24 and npm. Full portable packaging also builds the client helper and requires .NET SDK 10 plus Visual C++ build tools and the Windows SDK.

```powershell
git clone https://github.com/Regrad/pi-desktop.git
cd pi-desktop
npm ci
npm run dev
```

| Command | Purpose |
| --- | --- |
| `npm run build` | Type-check and build the renderer, Electron host, and embedded Pi |
| `npm run dev` | Start the development app |
| `npm run release:update` | Update changed modules in `release/Pi Desktop`; fall back to full packaging when needed |
| `npm run pack` | Build a complete portable application while preserving its existing data folder |
| `npm run engine:verify` | Verify the original upstream source and bundled assets |
| `npm run engine:sync -- --ref vX.Y.Z` | Import a reviewed upstream Pi release |

The packaged executable is `release\Pi Desktop\app\Pi Desktop.exe`. Build scripts check that source inputs have not changed during compilation. Release activation uses staging and rollback; app data stays separate.

### Embedded Pi architecture

- `vendor/pi/` contains the original upstream source; desktop-specific changes stay outside it.
- `vendor/pi.upstream.json` records the upstream version, commit, and integrity hashes.
- `vendor/pi-assets/` contains pinned release assets absent from the upstream Git tree.
- `resources/pi-engine/` owns SDK startup and the desktop protocol adapter.
- Desktop extensions own goals, plans, notebooks, skills, browser integration, and media tools.

A private worker process keeps engine work isolated from the interface. It is managed by Pi Desktop and does not launch the Pi CLI. Compatibility transforms apply to generated JavaScript and reject unsupported upstream layouts.

See [the embedded engine integration plan](docs/PI_EMBEDDED_ENGINE_PLAN.md) for update boundaries and acceptance checks.

### Validation and screenshots

```powershell
npm run build
node --test scripts/interface-language.test.mjs scripts/source-integrity.test.mjs
npx electron scripts/interface-language-smoke.cjs
```

The UI smoke test verifies English defaults, both language switches, persisted preferences, and draft preservation using an isolated fixture profile. On Windows, its temporary profile is under `C:\AI_Temp`. To refresh the README image, run:

```powershell
npx electron scripts/interface-language-smoke.cjs --capture-readme
```

This renders the real app with fictional demo data. It never loads the installed application's `data` folder or calls a model.

Other regression suites live in `scripts/*.test.mjs`. Live model or ComfyUI checks may require separately configured services.

## Local automation API

Pi Desktop exposes an authenticated control API on a random **127.0.0.1-only** port. The address and per-launch token are written to `data/control-api/connection.json` and removed on exit. Keep this file private: its token authorizes work with the app's permissions.

The bundled `Invoke-PiDesktop.ps1` discovers the connection for the current installation. The MCP bridge is `resources/control-api/mcp.mjs`; its tools can list projects and chats, select a chat, start work, inspect status, reply, and abort. Work appears in the normal interface, and polling does not resend tasks.

## Web access status

Optional HTTPS and remote-helper implementations are included in the source. The Web Access settings entry is currently hidden while the feature is paused. The default workflow is the local desktop app; building the project does not enable public web access.

## License

Pi Desktop's own code is available under the [MIT License](LICENSE).

Embedded Pi and third-party components retain their licenses and copyright notices, including [Pi](vendor/pi/LICENSE) and [PixelArtistry](resources/pi-comfyui/tools/comfyui_generate_3d/PIXELARTISTRY-LICENSE).
