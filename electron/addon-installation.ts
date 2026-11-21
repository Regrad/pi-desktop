import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Versions tested with this build's embedded Pi and compatibility patches.
export const testedAddons = {
  "pi-tool-repair": "0.3.10",
  "pi-mcp-adapter": "7.0.1",
  "pi-lens": "4.5.1",
} as const;

export type ManagedAddon = keyof typeof testedAddons;

export function versionIsNewer(version: string, current: string): boolean {
  if (![version, current].every(value => /^\d+\.\d+\.\d+$/.test(value))) return false;
  const previous = current.split(".").map(Number);
  for (const [index, part] of version.split(".").map(Number).entries()) {
    if (part !== previous[index]) return part > previous[index];
  }
  return false;
}

export function addonDirectory(runtime: string, name: ManagedAddon): string {
  return path.join(runtime, "desktop-addons", name);
}

export function addonPointer(runtime: string, name: ManagedAddon): string {
  return path.join(addonDirectory(runtime, name), "active.json");
}

function packageVersion(directory: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).version;
    return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

export function resolveAddonPackage(runtime: string, bundled: string, name: string): string {
  const legacy = path.join(runtime, "node_modules", name);
  if (!Object.hasOwn(testedAddons, name)) return existsSync(path.join(legacy, "package.json")) ? legacy : bundled;
  const addon = name as ManagedAddon;
  const bundledVersion = packageVersion(bundled);
  const permitted = (location: string) => {
    const version = packageVersion(location);
    return version && (!bundledVersion || !versionIsNewer(bundledVersion, version))
      && (version === testedAddons[addon] || version === bundledVersion);
  };
  try {
    const generation = JSON.parse(readFileSync(addonPointer(runtime, addon), "utf8")).generation;
    if (typeof generation === "string" && /^generation-[a-zA-Z0-9]{6}$/.test(generation)) {
      const location = path.join(addonDirectory(runtime, addon), generation, "node_modules", addon);
      if (permitted(location)) return location;
    }
  } catch { /* An absent or damaged pointer falls back to the known package. */ }
  return permitted(legacy) ? legacy : bundled;
}
