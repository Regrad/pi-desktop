# Embedded Pi engine refactor

Baseline: `90f2102` (desktop source snapshot before this migration).
Upstream: https://github.com/earendil-works/pi, tag `v1.5.2`,
commit `b4afdddf44e059c67ccf5097e5317d913521b470`, MIT.

## Boundaries

- `vendor/pi/`: byte-preserved upstream source snapshot. No desktop edits here.
  Source provenance and file hashes live outside that tree. Updating this tree
  is a deliberate source integration, not an end-user npm update.
- `vendor/pi-assets/`: versioned release data/native assets absent from Git,
  with provenance and hashes. These are inputs, not a substitute for source.
- `resources/pi-engine/`: desktop-owned SDK bootstrap and protocol adapter.
  It creates sessions using Pi's SDK, without invoking its CLI or `main()`.
- Existing desktop extensions own goals, planning, browser, media, notebooks
  and skills. Existing behavior must survive the migration.
- Necessary compatibility transformations apply only to generated JavaScript.
  Originals stay untouched; unsupported source fails the build. Move behavior
  to SDK/extension hooks where supported; do not discard required fixes merely
  to claim an unpatched integration.
- Electron owns the engine worker. A private subprocess isolates global state,
  CPU work, cancellation and failures from the UI. It is part of this app and
  requires no separately installed Pi executable or user-managed Pi runtime.

## Execution plan

1. [x] Commit the current source version.
2. [x] Run existing runtime regression tests as a baseline.
3. [x] Import pristine upstream source and release-only assets; record hashes,
   license and a repeatable source-update command with local-edit protection.
4. [x] Build local Pi packages from source as part of the application build;
   resolve internal Pi dependencies to one coherent local package set.
5. [x] Bootstrap the engine through SDK services and route desktop requests to
   the owned adapter. Preserve history, title generation, queue settlement,
   goals, plans, tool permissions, media, model reload and cancellation.
6. [x] Remove Pi Core's independent npm installation/update route and stale
   runtime override selection. Show the embedded engine version in the UI.
   Preserve independent third-party extension management where applicable.
7. [x] Update packaging, remote runtime and documentation; verify license and
   compiled engine assets are present in the portable build.
8. [x] Run contract/regression checks and a packaged runtime smoke test without
   a Pi CLI; commit the refactor and deliver the verified build.

## Acceptance

- The imported upstream source still matches its recorded hashes after build.
- A fresh dependency install uses the checked-in Pi sources, not a registry
  copy of the engine. Building does not modify upstream TypeScript.
- The desktop launches its own SDK entry, never Pi's CLI entry.
- An old `data/runtime` Pi override cannot replace the embedded engine.
- Existing chats/auth/configuration remain intact; smoke tests use isolated
  data under `C:\AI_Temp` and a local mock provider, not paid model calls.
- Runtime tests cover tools, nested media, cancellation, model reload, goals,
  normal-mode planning, title generation and persisted request history.
- Upstream updates preserve desktop code; changed compatibility assumptions
  stop the candidate build before it can replace a working portable release.

## Update policy

The source-update command imports an explicit upstream ref and records the
resolved commit. Review the source/dependency diff, install the pinned local
workspace dependencies, build and run the compatibility suite, then package
the app. Keep the previous application release for rollback. Updating Pi and
releasing the desktop are separate operations; source synchronization alone
must not touch the installed portable app or user data.

## Integration details

- Source archives retain the upstream bytes. Verification records SHA-256 hashes
  and permits only Git's prescribed LF/CRLF conversions for valid UTF-8 text.
  Added, removed or edited original files stop source synchronization; generated
  dist/node_modules and hydrated release assets are excluded from source scans.
- All eight first-party packages are npm workspaces. No registry copy of the
  coding engine participates in the runtime. Pi Lens 4.3.0 has an old optional
  TUI peer range; a narrow npm override selects the tested local TUI 1.5.2.
- The SDK adapter preserves extension ordering, trusted-project behavior,
  settings, HTTP proxy, theme validation, model selection, session lifecycle
  and the existing desktop protocol. Internal Pi utility imports are confined
  to resources/pi-engine/bindings.mjs. Pi's public SDK exports CLI functions;
  those inert exports are allowed, but the desktop never calls main() or an
  executable CLI entry. A runtime import guard checks that boundary.
- resources/pi-engine/version.js is the reviewed compatibility version.
  Review it and the Pi Lens peer override after each source update; never
  automatically accept a new version merely because it was imported.
- Compatibility transformations remain necessary for desktop service context,
  tool routing/permissions, timeouts, media, diagnostics and continuation.
  They touch generated JavaScript only. Third-party addon fixes are reapplied
  even when the engine build is cached after npm ci.
- Runtime npm updates cover third-party addons only. Old first-party overrides
  remain on disk to preserve user data but cannot replace the embedded engine.
  Local and remote PiManager instances use the same owned worker entry.
- Packaging verifies all eight versions, in-package paths, the MIT notice and
  upstream commit, then runs tool/media/MCP/abort/title/session tests using the
  packaged Electron executable before activating a release.

## Updating the source next time

1. Commit desktop work; run npm run engine:verify.
2. Run npm run engine:sync -- --ref vX.Y.Z. An optional --from path uses an
   existing clone with the official origin. Imports stage and back up in
   C:\AI_Temp; source code outside vendor is not rewritten.
3. Review upstream changes, private SDK bindings and generated compatibility
   transforms. Update the reviewed version and narrow peer override.
4. Run npm install to update the lockfile, then npm run build and the runtime
   regression suite. npm ci reproduces the lockfile on a clean checkout.
5. Run npm run pack. A failed packaged-engine check leaves the installed app
   unchanged. Commit the vendor/manifests/lockfile and reviewed adapter changes.

## Final validation

- Baseline: 96/96 tests against the original npm runtime before migration.
- Pi 1.5.2 SDK runtime: the same 96/96 passed, including 53 extension tools
  and 54 callable declarations, MCP discovery/reload, media and cancellation.
- Clean npm ci --ignore-scripts: 852 packages installed from the lockfile;
  subsequent full TypeScript/Vite/engine build passed. For development launch,
  use normal npm ci (Electron's binary installer is a dependency lifecycle).
- Added checks for source-edit protection, a coherent embedded package set,
  legacy override rejection and full rebuild selection. History survives a
  worker restart and new-session/switch-session transitions.

- Final combined regression: 170 tests, 169 passed, zero failures; one live
  ComfyUI-schema check skipped because that optional server was not running.
  The Pi Lens prefix check excludes only its documented one-shot advisory;
  stable system/user/tool history remains compared in full.
- Packaged Electron contract: 9/9 tests passed before activation, including
  tools/media/MCP, model refresh, cancellation, title generation and session
  restart/switching. License and all eight embedded versions verified.
- Git checkout round trip of all staged vendor files passed the same source
  integrity verifier, including Windows line-ending conversions.
- Installed release: release/Pi Desktop/app/Pi Desktop.exe. The final modular
  refresh changed two inputs and zero active-addon files. User data retained.
- No new live ComfyUI generation, remote-device session or manual GUI review
  was performed for this engine refactor; those are not claimed by these checks.
