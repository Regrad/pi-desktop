# 3D models, sprites and voxels

Pi Desktop includes three optional art workflows:

| Workflow | Editor | Outputs |
| --- | --- | --- |
| `blender-modeling` | [Blender](https://www.blender.org/download/) | `.blend`, GLB and other Blender export formats |
| `pixel-art` | [Aseprite](https://www.aseprite.org/) with [Aseprite AI Artist](https://github.com/with-pebbly/aseprite-ai-artist) | `.aseprite`, PNG, GIF, sprite sheets and atlases |
| `voxel-art` | [Froxel](https://github.com/theromis/Froxel/releases/latest) | `.vox`, PNG, GLB with optional bones and animation |

Ask for an asset in a chat, or explicitly invoke `/skill:pixel-art`,
`/skill:blender-modeling` or `/skill:voxel-art`. The model reads the matching
workflow and connects that editor through MCP. Ordinary conversations only
receive the small skill catalog. Editors are not checked or started when the
app starts or a chat opens. Their tool schemas and full instructions are
loaded on demand, independently in each chat.

## Install an editor

Install whichever editors you need on your computer. They are not included in
the Pi Desktop download. No Python, Node.js or npm installation is required
to run these integrations. Blender uses its own Python, Froxel has a native
MCP server, and Aseprite AI Artist runs on Pi Desktop's embedded Node runtime.

Use Blender 4.2 or newer and Aseprite 1.3 or newer. Aseprite's ready-made builds
are paid. Its [official FAQ](https://aseprite.org/faq/) also permits compiling
the [official source](https://github.com/aseprite/aseprite/blob/main/INSTALL.md)
for your own use, including creating commercial game art. That compiled
editor must not be redistributed with Pi Desktop.

Pi Desktop looks on PATH and in common Windows installation folders, including
Blender Foundation, Steam's default Aseprite folder, and the current user's
Programs folder. It does not search whole drives. Portable installations or
Steam libraries on another disk can be configured in
`data/agent/creative-tools.json`:

```json
{
  "blender": { "executable": "D:/Apps/Blender/blender.exe" },
  "aseprite": { "executable": "D:/Apps/Aseprite/aseprite.exe", "mode": "headless" },
  "froxel": { "executable": "D:/Apps/Froxel/froxel.exe", "mode": "headless" }
}
```

Leave `executable` empty to detect it automatically. An explicit invalid path
produces an error instead of silently choosing another editor. Paths belong
to the local installation's data folder and are never written into the skills.
After changing a path, reconnect that server or start a new chat runtime.
Environment overrides `PI_DESKTOP_BLENDER_PATH`, `PI_DESKTOP_ASEPRITE_PATH` and
`PI_DESKTOP_FROXEL_PATH` are also supported.

## Background and window modes

Background mode is the default. Different chats have separate sprite and voxel
documents. Blender works in the `.blend` file named in each tool call and
saves it after successful code execution. The model must save sprites and
voxels before finishing, since their in-memory documents disappear when the
runtime closes. Save different assets under different paths when working in
multiple chats.

For Aseprite's open window, install the Aseprite AI Artist extension from its
upstream instructions and set `aseprite.mode` to `window`. For a Froxel window,
set `froxel.mode` to `window`; it connects to `127.0.0.1:7979` and opens the
editor if necessary. Window modes share the editor's document, so use them in
one chat at a time. Blender's integration uses background mode.

Aseprite AI Artist 0.8.4 is pinned in `package-lock.json` under MIT. Its full
workflows, rules and templates are loaded only when needed. Packaged builds
extract its small resource folder into `data/runtime/creative-tools/` on first
use because an external Lua interpreter cannot read Electron's ASAR archive.
Blender's adapter is Pi Desktop code. No code is copied from unlicensed MCP
repositories. Froxel remains a separately installed editor under its own MIT
license. Editor updates are independent from Pi Desktop updates.
