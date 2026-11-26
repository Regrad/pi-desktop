---
name: pixel-art
description: Draw, edit, animate or export pixel-art sprites, tilesets, icons and sprite sheets with Aseprite when the user requests an art asset. Do not use for ordinary UI code, CSS, image file handling or discussing graphics APIs.
---

# Pixel art and sprite animation

Check the current Pi Desktop access state first. While Agree first is unapproved,
inspect references and existing files with native read/search tools, discuss the
scope, then explain the proposal once in chat and call `request_changes({})`.
Do not connect the editor, call preflight or start generation before interface
approval and the user's next message. In Plan mode use the planning review and
only permitted reads. With permission, continue with the workflow below.

Use only for the requested drawing task in this chat. Discover the MCP gateway
through codemode and connect `mcp({server:"aseprite"})`. Read the server's
instructions and its `skill://studio` resource using the discovered resource
tool. The bundled Aseprite AI Artist contains the detailed drawing, shading,
animation, review, export, palette and tileset workflows. Read only the stages
needed for this request, rather than loading all of them.

Pi Desktop starts this server in headless mode by default. The model designs
and places the pixels through the editor's tools; an image generator is not
required. Call `preflight` before editing. If the user explicitly requests
their Aseprite window, use live mode only when its extension is connected.
Never silently switch an open document to a background copy.

Confirm the canvas, view, palette and animation requirements from the brief
and existing project. Keep user references and intentional pixel-art style.
Use palette-index grids for controlled drawing and edits. Inspect `look`
previews after significant changes and compare the entire silhouette and
animation, not just a successful tool result. Follow the server's review
workflow without assuming that this harness has specialist subagents.

Save an editable `.aseprite` project before finishing; unsaved background
documents disappear when the chat runtime stops. Export the requested PNG,
GIF or sprite sheet plus atlas into the project. Show a preview and report
the actual output paths. Reopen the saved document when continuing later.

If Aseprite is missing, explain the setup information returned by the server.
Users may buy it or build their own copy from official source. Do not download
third-party binaries or redistribute a locally compiled Aseprite in Pi Desktop.
