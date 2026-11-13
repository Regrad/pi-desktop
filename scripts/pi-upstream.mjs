// Deliberate source integration, never an end-user runtime updater.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { inventory, textInventory, verifyUpstream } from "./pi-upstream-state.mjs";
import { npmCommand } from "../electron/npm-command.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const repository = "https://github.com/earendil-works/pi.git";
const previous = await verifyUpstream(root);
if (args.length === 1 && args[0] === "--check") {
  console.log(`Verified pristine Pi ${previous.version} (${previous.commit}), including release assets.`);
} else {
  const value = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const ref = value("--ref");
  if (!ref || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(ref) || args.some((arg, i) => i % 2 === 0 && !["--ref", "--from"].includes(arg))) {
    throw new Error("Usage: npm run engine:sync -- --ref vX.Y.Z [--from local-official-clone]");
  }
  const tempRoot = process.platform === "win32" ? "C:\\AI_Temp" : "/tmp/pi-desktop";
  await mkdir(tempRoot, { recursive: true });
  const staging = await mkdtemp(path.join(tempRoot, "pi-source-"));
  const run = (exe, argv, cwd = staging) => execFileSync(exe, argv, { cwd, encoding: "utf8", windowsHide: true, timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, TEMP: tempRoot, TMP: tempRoot } }).trim();
  const checkout = value("--from") ? path.resolve(value("--from")) : path.join(staging, "checkout");
  if (!value("--from")) run("git", ["clone", "--depth", "1", "--branch", ref, repository, checkout]);
  const origin = run("git", ["remote", "get-url", "origin"], checkout).replace(/\.git$/, "");
  if (origin !== repository.replace(/\.git$/, "")) throw new Error(`Unexpected Pi source origin: ${origin}`);
  const commit = run("git", ["rev-parse", `${ref}^{commit}`], checkout);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid upstream commit");
  const source = path.join(staging, "pi");
  await mkdir(source);
  const archive = path.join(staging, "source.tar");
  run("git", ["archive", "--format=tar", `--output=${archive}`, commit], checkout);
  run("tar", ["-xf", archive, "-C", source]);
  const version = JSON.parse(await readFile(path.join(source, "packages/coding-agent/package.json"), "utf8")).version;
  if (ref !== `v${version}`) throw new Error("Source tag/version mismatch");
  if (!(await readFile(path.join(source, "LICENSE"), "utf8")).includes("MIT License")) throw new Error("Upstream license changed; review before importing");
  for (const name of previous.packages) {
    const pkg = JSON.parse(await readFile(path.join(source, "packages", name, "package.json"), "utf8"));
    if (pkg.version !== version) throw new Error(`Incoherent Pi package version: ${name}`);
  }
  const assets = path.join(staging, "pi-assets");
  await mkdir(assets);
  const provenance = [];
  for (const [name, from, to] of [["pi-ai", "dist/providers/data", "ai-provider-data"], ["pi-tui", "native/win32/prebuilds", "tui-win32-prebuilds"]]) {
    const packageName = `@earendil-works/${name}`;
    const npm = npmCommand(["pack", `${packageName}@${version}`, "--ignore-scripts", "--json", "--pack-destination", staging, "--cache", path.join(tempRoot, "npm-cache")], process.execPath);
    const [packed] = JSON.parse(run(npm.executable, npm.args));
    const tarball = path.join(staging, packed.filename);
    const integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
    if (integrity !== packed.integrity) throw new Error(`npm integrity mismatch: ${packageName}`);
    const unpack = path.join(staging, name);
    await mkdir(unpack);
    run("tar", ["-xf", tarball, "-C", unpack]);
    const pkg = JSON.parse(await readFile(path.join(unpack, "package/package.json"), "utf8"));
    if (pkg.name !== packageName || pkg.version !== version) throw new Error("Release asset package mismatch");
    await cp(path.join(unpack, "package", from), path.join(assets, to), { recursive: true });
    provenance.push({ package: packageName, version, path: from, integrity });
  }
  const files = await inventory(source);
  await writeFile(path.join(staging, "pi.upstream.json"), JSON.stringify({ repository, ref, commit, version, license: "MIT", packages: previous.packages, files, textHashes: await textInventory(source, files) }, null, 2) + "\n");
  await writeFile(path.join(staging, "pi-assets.json"), JSON.stringify({ version, sources: provenance, files: await inventory(assets) }, null, 2) + "\n");
  // Recheck immediately before replacement: local changes must never be lost.
  await verifyUpstream(root);
  const backup = path.join(staging, "previous");
  await mkdir(backup);
  const moved = [];
  try {
    for (const name of ["pi", "pi-assets", "pi.upstream.json", "pi-assets.json"]) {
      const destination = path.join(root, "vendor", name);
      await rename(destination, path.join(backup, name));
      moved.push(name);
      await rename(path.join(staging, name), destination);
    }
    await verifyUpstream(root);
  } catch (error) {
    for (const name of moved.reverse()) {
      const destination = path.join(root, "vendor", name);
      try { await rename(destination, path.join(staging, `failed-${name}`)); } catch (e) { if (e.code !== "ENOENT") throw e; }
      await rename(path.join(backup, name), destination);
    }
    throw error;
  }
  console.log(`Imported pristine Pi ${version} (${commit}). Previous source preserved at ${backup}.`);
  console.log("Next: npm install --ignore-scripts; npm run engine:build; run regression tests. Compatibility adapters require explicit review for this version. Installed apps and user data were not changed.");
}
