// Only this module knows Pi's non-public paths. Review these contracts when
// upgrading the pinned source; the desktop never calls Pi's CLI entry point.
import { findPackageJSON } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_PI_VERSION } from "./version.js";

const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
const pkg = JSON.parse(readFileSync(manifest, "utf8"));
if (pkg.version !== SUPPORTED_PI_VERSION) {
  throw new Error(`Desktop engine adapter requires Pi ${SUPPORTED_PI_VERSION}; found ${pkg.version}`);
}
const internal = relative => import(pathToFileURL(path.join(path.dirname(manifest), "dist", relative)).href);
export const { KeybindingsManager } = await internal("core/keybindings.js");
export const { flushRawStdout, takeOverStdout, waitForRawStdoutBackpressure, writeRawStdout } = await internal("core/output-guard.js");
export const { killTrackedDetachedChildren } = await internal("utils/shell.js");
const themeModule = await internal("modes/interactive/theme/theme.js");
export const getTheme = () => themeModule.theme;
const { validateThemeJson } = await internal("modes/interactive/theme/theme-schema.js");
export const initializeThemeValidation = () => themeModule.setThemeJsonValidator(validateThemeJson);
export const { toJsonEvent } = await internal("modes/json-event.js");
export const { attachJsonlLineReader, serializeJsonLine } = await internal("modes/rpc/jsonl.js");
export const { builtInExtensions } = await internal("extensions/index.js");
export const { applyHttpProxySettings, configureHttpDispatcher } = await internal("core/http-dispatcher.js");
export const { resolveModelScope } = await internal("core/model-resolver.js");
