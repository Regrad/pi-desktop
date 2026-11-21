import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  UpdateComponentId,
  UpdateComponentStatus,
  UpdateResult,
  UpdateStatus,
} from "../shared/types.js";
import { DataStore } from "./data-store.js";
import { PiRpcProcess } from "./pi-rpc-process.js";
import { npmCommand } from "./npm-command.js";
import { atomicStateWrite } from "./atomic-state.js";
import { addonDirectory, addonPointer, testedAddons, versionIsNewer, type ManagedAddon } from "./addon-installation.js";

interface ComponentDefinition {
  id: UpdateComponentId;
  packageName: ManagedAddon;
  name: string;
  description: string;
}

const COMPONENTS: ComponentDefinition[] = [
  { id: "pi-tool-repair", packageName: "pi-tool-repair", name: "Tool Repair", description: "Исправление некорректных вызовов инструментов." },
  { id: "pi-mcp-adapter", packageName: "pi-mcp-adapter", name: "MCP Adapter", description: "Подключение MCP-серверов и их инструментов." },
  { id: "pi-lens", packageName: "pi-lens", name: "Pi Lens", description: "Динамический набор и отображение инструментов." },
];

const LOCAL_COMPONENTS: Array<Omit<UpdateComponentStatus, "updateAvailable">> = [
  { id: "pi-llama-generation-speed", name: "Generation Speed", description: "Показывает текущую скорость генерации llama.cpp.", updateable: false, source: "local" },
  { id: "pi-loop-police", name: "Loop Police", description: "Локальная настроенная защита от реальных циклов.", updateable: false, source: "local" },
];

export class UpdateManager {
  private cachedStatus?: UpdateStatus;
  private operation: Promise<UpdateResult> | undefined;

  constructor(
    private readonly store: DataStore,
    private readonly appRoot: string,
    private readonly runtimeExecutable: string,
  ) {}

  async getStatus(force = false): Promise<UpdateStatus> {
    if (!force && this.cachedStatus && Date.now() - Date.parse(this.cachedStatus.checkedAt ?? "") < 300_000) {
      return structuredClone(this.cachedStatus);
    }
    const npmAvailable = await this.hasNpm();
    const components = await Promise.all(COMPONENTS.map(async (definition): Promise<UpdateComponentStatus> => {
      const packagePath = this.store.getEffectivePackagePath(definition.packageName);
      const currentVersion = await readPackageVersion(packagePath);
      let upstreamVersion: string | undefined;
      let error: string | undefined;
      try {
        upstreamVersion = await fetchLatestVersion(definition.packageName);
      } catch (statusError) {
        error = statusError instanceof Error ? statusError.message : String(statusError);
      }
      const tested = testedAddons[definition.packageName];
      const hasTestedUpdate = Boolean(currentVersion && versionIsNewer(tested, currentVersion));
      const requiresCompatibleBuild = Boolean(!hasTestedUpdate && currentVersion && upstreamVersion
        && versionIsNewer(upstreamVersion, currentVersion));
      return {
        ...definition,
        currentVersion,
        latestVersion: hasTestedUpdate ? tested : requiresCompatibleBuild ? upstreamVersion : currentVersion,
        updateAvailable: hasTestedUpdate,
        updateable: npmAvailable && hasTestedUpdate,
        requiresCompatibleBuild,
        source: packagePath === path.join(this.appRoot, "node_modules", definition.packageName) ? "bundled" : "portable",
        ...(error ? { error } : {}),
      };
    }));
    const status: UpdateStatus = {
      checkedAt: new Date().toISOString(),
      npmAvailable,
      components: [
        { id: 'pi-core', name: 'Pi Engine', description: 'Встроенный движок. Обновляется вместе с приложением.',
          currentVersion: await readPackageVersion(this.store.getEffectivePackagePath('@earendil-works/pi-coding-agent')),
          source: 'bundled', updateAvailable: false, updateable: false },
        ...components,
        ...LOCAL_COMPONENTS.map((component) => ({ ...component, updateAvailable: false })),
      ],
    };
    this.cachedStatus = status;
    return structuredClone(status);
  }

  updateComponent(id: UpdateComponentId): Promise<UpdateResult> {
    if (id === 'pi-core') throw new Error('Встроенный Pi обновляется вместе с приложением');
    return this.runExclusive([id]);
  }

  updateAll(): Promise<UpdateResult> {
    return this.runExclusive(COMPONENTS.map((component) => component.id));
  }

  private runExclusive(ids: UpdateComponentId[]): Promise<UpdateResult> {
    if (this.operation) throw new Error("Другое обновление уже выполняется");
    this.operation = this.performUpdates(ids).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  private async performUpdates(ids: UpdateComponentId[]): Promise<UpdateResult> {
    const status = await this.getStatus();
    if (!status.npmAvailable) throw new Error("Для обновления нужен npm. Установите Node.js или добавьте npm в PATH");
    const updated: string[] = [];
    const errors: string[] = [];

    for (const id of ids) {
      const definition = COMPONENTS.find((component) => component.id === id);
      const component = status.components.find((item) => item.id === id);
      if (!definition || !component?.latestVersion || !component.updateAvailable || !component.updateable) continue;
      try {
        await this.installCandidate(definition.packageName, component.latestVersion);
        updated.push(definition.name);
      } catch (error) {
        errors.push(`${definition.name}: ${errorText(error)}`);
      }
    }

    this.cachedStatus = undefined;
    return { status: await this.getStatus(true), updated, errors };
  }

  private async installCandidate(name: ManagedAddon, version: string): Promise<void> {
    if (testedAddons[name] !== version) throw new Error("Эта версия дополнения ещё не проверена для Pi Desktop");
    const runtime = this.store.runtimePackagesDir;
    const directory = addonDirectory(runtime, name);
    const pointer = addonPointer(runtime, name);
    await mkdir(directory, { recursive: true });
    const previous = await readFile(pointer, "utf8").catch(error => {
      if (error.code === "ENOENT") return "{}\n";
      throw error;
    });
    const stage = await mkdtemp(path.join(directory, "generation-"));
    let keep = false;
    try {
      await writeFile(path.join(stage, "package.json"), '{"name":"pi-desktop-addon","private":true}\n', "utf8");
      await this.runNpm(["install", "--prefix", stage, "--save-exact", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps",
        "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org", `${name}@${version}`], 180_000, stage);
      const candidate = path.join(stage, "node_modules", name);
      if (await readPackageVersion(candidate) !== version) throw new Error("npm установил другую версию дополнения");
      await this.linkBundledPeers(stage, candidate);
      await this.applyAddonCompatibility(name, candidate);
      if (name === "pi-lens") await this.applyLensGrammarCache(candidate);
      await this.smokeTestRuntime(candidate);

      await atomicStateWrite(pointer, `${JSON.stringify({ generation: path.basename(stage) })}\n`);
      keep = true;
      try {
        await this.store.refreshManagedPackageConfiguration();
      } catch (error) {
        try {
          await atomicStateWrite(pointer, previous);
          keep = false;
        } catch (rollbackError) {
          throw new Error(`${errorText(error)}; не удалось восстановить прежнее дополнение: ${errorText(rollbackError)}`);
        }
        throw error;
      }
    } finally {
      if (!keep && path.dirname(path.resolve(stage)) === path.resolve(directory)) {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async linkBundledPeers(stage: string, candidate: string): Promise<void> {
    const manifest = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8")) as { peerDependencies?: Record<string, string> };
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (!/^(?:@[a-z0-9_-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error("Недопустимое имя зависимости дополнения");
      const bundled = path.join(this.appRoot, "node_modules", name);
      const link = path.join(stage, "node_modules", name);
      if (!existsSync(path.join(bundled, "package.json")) || existsSync(link)) continue;
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(bundled, link, process.platform === "win32" ? "junction" : "dir");
    }
  }

  private async applyLensGrammarCache(candidate: string): Promise<void> {
    const patchFile = path.join(this.appRoot, "resources", "pi-lens", "grammar-cache-patch.mjs");
    const { applyPiLensGrammarCache } = await import(pathToFileURL(patchFile).href);
    await applyPiLensGrammarCache(candidate);
    const grammarFile = path.join(this.appRoot, "resources", "pi-lens", "grammars.mjs");
    const { ensurePiLensGrammars } = await import(pathToFileURL(grammarFile).href);
    await ensurePiLensGrammars(candidate);
  }

  private async applyAddonCompatibility(name: ManagedAddon, candidate: string): Promise<void> {
    if (name !== "pi-mcp-adapter") return;
    const compatibility = path.join(this.appRoot, "resources", "pi-rpc-bridge", "compatibility.js");
    const { applyAddonRequestCompatibility } = await import(pathToFileURL(compatibility).href);
    await applyAddonRequestCompatibility(name, candidate);
  }

  private async smokeTestRuntime(candidate: string): Promise<void> {
    const smokeDir = await mkdtemp(path.join(tmpdir(), "pi-desktop-update-"));
    try {
      const agent = path.join(smokeDir, "agent");
      await mkdir(agent);
      await writeFile(path.join(agent, "settings.json"), JSON.stringify({ packages: [candidate] }), "utf8");
      const errors: string[] = [];
      const rpc = new PiRpcProcess({
        executablePath: this.runtimeExecutable,
        enginePath: this.store.getEngineEntryPath(),
        cwd: smokeDir,
        agentDir: agent,
        sessionsDir: path.join(smokeDir, "sessions"),
        sessionId: `update-smoke-${randomUUID()}`,
        appRoot: this.appRoot,
        mcpEntryPath: path.join(this.appRoot, "node_modules", "@zavora-ai", "computer-use-mcp", "dist", "server.js"),
        mcpDirectTools: [],
        remoteEnvironment: { PI_OFFLINE: "1", PI_LENS_HOME: path.join(smokeDir, "pi-lens") },
        onEvent: (event) => { if (event.type === "extension_error") errors.push(String(event.error)); },
        onExtensionUi: () => undefined,
        onExit: (error) => { if (error) errors.push(error.message); },
      });
      try {
        await rpc.start();
        await rpc.request("get_state", {}, 20_000);
        const state = await rpc.request<{ extensionPaths: string[] }>("get_extension_state", {}, 20_000);
        const loaded = state.extensionPaths.some(file => {
          const relative = path.relative(candidate, file);
          return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        });
        if (errors.length) throw new Error(errors.join("\n"));
        if (!loaded) throw new Error("Проверка не обнаружила загруженное дополнение");
      } finally {
        await rpc.stop();
      }
    } finally {
      await rm(smokeDir, { recursive: true, force: true });
    }
  }

  private async hasNpm(): Promise<boolean> {
    try {
      await mkdir(this.store.runtimePackagesDir, { recursive: true });
      await this.runNpm(["--version"], 10_000);
      return true;
    } catch {
      return false;
    }
  }

  private runNpm(args: string[], timeoutMs = 180_000, cwd = this.store.runtimePackagesDir): Promise<string> {
    return new Promise((resolve, reject) => {
      const command = npmCommand(args, this.runtimeExecutable);
      const child = spawn(command.executable, command.args, {
        cwd,
        env: command.env,
        windowsHide: true,
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("npm не завершил операцию вовремя"));
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-32_000); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32_000); });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || stdout.trim() || `npm завершился с кодом ${code}`));
      });
    });
  }
}

async function readPackageVersion(packagePath: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

async function fetchLatestVersion(packageName: string): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`реестр npm ответил ${response.status}`);
  const manifest = await response.json() as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("реестр npm не вернул версию");
  return assertSafeVersion(manifest.version);
}

function assertSafeVersion(version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw new Error("npm вернул недопустимую версию пакета");
  return version;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
