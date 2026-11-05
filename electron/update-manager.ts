import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

interface ComponentDefinition {
  id: UpdateComponentId;
  packageName: string;
  name: string;
  description: string;
}

const COMPONENTS: ComponentDefinition[] = [
  {
    id: "pi-core",
    packageName: "@earendil-works/pi-coding-agent",
    name: "Pi Core",
    description: "Ядро агента и штатные инструменты Pi.",
  },
  { id: "pi-web-access", packageName: "pi-web-access", name: "Web Access", description: "Поиск и чтение веб-страниц." },
  { id: "pi-tool-repair", packageName: "pi-tool-repair", name: "Tool Repair", description: "Исправление некорректных вызовов инструментов." },
  { id: "pi-llama-cpp-stats", packageName: "pi-llama-cpp-stats", name: "llama.cpp Stats", description: "Статистика prompt processing и генерации." },
  { id: "pi-mcp-adapter", packageName: "pi-mcp-adapter", name: "MCP Adapter", description: "Подключение MCP-серверов и их инструментов." },
  { id: "pi-lens", packageName: "pi-lens", name: "Pi Lens", description: "Динамический набор и отображение инструментов." },
];

const LOCAL_COMPONENTS: Array<Omit<UpdateComponentStatus, "updateAvailable">> = [
  { id: "pi-single-slot-guard", name: "Single Slot Guard", description: "Защищает KV-кэш при работе с одним слотом llama.cpp.", updateable: false, source: "local" },
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
      let latestVersion: string | undefined;
      let error: string | undefined;
      try {
        latestVersion = await fetchLatestVersion(definition.packageName);
      } catch (statusError) {
        error = statusError instanceof Error ? statusError.message : String(statusError);
      }
      const portablePath = path.join(this.store.runtimePackagesDir, "node_modules", definition.packageName);
      return {
        ...definition,
        currentVersion,
        latestVersion,
        updateAvailable: Boolean(currentVersion && latestVersion && currentVersion !== latestVersion),
        updateable: npmAvailable && Boolean(latestVersion),
        source: existsSync(path.join(portablePath, "package.json")) ? "portable" : "bundled",
        ...(error ? { error } : {}),
      };
    }));
    const status: UpdateStatus = {
      checkedAt: new Date().toISOString(),
      npmAvailable,
      components: [
        ...components,
        ...LOCAL_COMPONENTS.map((component) => ({ ...component, updateAvailable: false })),
      ],
    };
    this.cachedStatus = status;
    return structuredClone(status);
  }

  updateComponent(id: UpdateComponentId): Promise<UpdateResult> {
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
    const status = await this.getStatus(true);
    if (!status.npmAvailable) throw new Error("Для обновления нужен npm. Установите Node.js или добавьте npm в PATH");
    const updated: string[] = [];
    const errors: string[] = [];
    await this.ensureRuntimePackageRoot();

    for (const id of ids) {
      const definition = COMPONENTS.find((component) => component.id === id);
      const component = status.components.find((item) => item.id === id);
      if (!definition || !component?.latestVersion || !component.updateAvailable) continue;
      const overridePath = path.join(this.store.runtimePackagesDir, "node_modules", definition.packageName);
      const previousOverrideVersion = await readPackageVersion(overridePath);
      try {
        await this.runNpm([
          "install",
          "--prefix", this.store.runtimePackagesDir,
          "--save-exact",
          "--no-audit",
          "--no-fund",
          `${definition.packageName}@${assertSafeVersion(component.latestVersion)}`,
        ]);
        if (definition.id === "pi-core") await this.applyRpcBridge();
        await this.applyAddonCompatibility(definition.packageName);
        if (definition.packageName === "pi-lens") await this.applyLensGrammarCache();
        await this.store.refreshManagedPackageConfiguration();
        await this.smokeTestRuntime();
        updated.push(definition.name);
      } catch (error) {
        try {
          if (previousOverrideVersion) {
            await this.runNpm([
              "install",
              "--prefix", this.store.runtimePackagesDir,
              "--save-exact",
              "--no-audit",
              "--no-fund",
              `${definition.packageName}@${assertSafeVersion(previousOverrideVersion)}`,
            ]);
            if (definition.id === "pi-core") await this.applyRpcBridge();
            await this.applyAddonCompatibility(definition.packageName);
            if (definition.packageName === "pi-lens") await this.applyLensGrammarCache();
          } else {
            await this.runNpm(["uninstall", "--prefix", this.store.runtimePackagesDir, "--no-audit", "--no-fund", definition.packageName]);
          }
          await this.store.refreshManagedPackageConfiguration();
        } catch (rollbackError) {
          errors.push(`${definition.name}: откат не завершён (${errorText(rollbackError)})`);
        }
        errors.push(`${definition.name}: ${errorText(error)}`);
      }
    }

    this.cachedStatus = undefined;
    return { status: await this.getStatus(true), updated, errors };
  }

  private async ensureRuntimePackageRoot(): Promise<void> {
    await mkdir(this.store.runtimePackagesDir, { recursive: true });
    const packagePath = path.join(this.store.runtimePackagesDir, "package.json");
    if (!existsSync(packagePath)) {
      await writeFile(packagePath, `${JSON.stringify({ name: "pi-desktop-portable-runtime", private: true }, null, 2)}\n`, "utf8");
    }
  }

  private async applyLensGrammarCache(): Promise<void> {
    const patchFile = path.join(this.appRoot, "resources", "pi-lens", "grammar-cache-patch.mjs");
    const { applyPiLensGrammarCache } = await import(pathToFileURL(patchFile).href);
    await applyPiLensGrammarCache(this.store.getEffectivePackagePath("pi-lens"));
    const grammarFile = path.join(this.appRoot, "resources", "pi-lens", "grammars.mjs");
    const { ensurePiLensGrammars } = await import(pathToFileURL(grammarFile).href);
    await ensurePiLensGrammars(this.store.getEffectivePackagePath("pi-lens"));
  }

  private async applyRpcBridge(): Promise<void> {
    const corePath = this.store.getEffectivePackagePath("@earendil-works/pi-coding-agent");
    if (await readPackageVersion(corePath) !== "1.5.0") {
      throw new Error("RPC и отложенные инструменты проверены для Pi 1.5.0; новая версия требует проверки совместимости");
    }
    const destination = path.join(
      this.store.getEffectivePackagePath("@earendil-works/pi-coding-agent"),
      "dist", "modes", "rpc", "rpc-mode.js",
    );
    if (!existsSync(path.join(path.dirname(destination), "jsonl.js"))) {
      throw new Error("Новая версия Pi несовместима с RPC-интерфейсом Pi Desktop");
    }
    const routingRoot = path.join(this.appRoot, "resources", "tool-routing");
    const { patchToolRouting } = await import(pathToFileURL(path.join(routingRoot, "patch.js")).href);
    const loaderPath = path.join(corePath, "dist", "core", "extensions", "loader.js");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(loaderPath));
    const patched = patchToolRouting(source);
    await copyFile(path.join(routingRoot, "index.js"), path.join(path.dirname(loaderPath), "desktop-tool-routing.js"));
    if (patched !== source) await writeFile(loaderPath, patched, "utf8");
    await copyFile(path.join(this.appRoot, "resources", "pi-rpc-bridge", "rpc-mode.js"), destination);
    const compatibility = path.join(this.appRoot, "resources", "pi-rpc-bridge", "compatibility.js");
    const { applyCoreRequestCompatibility } = await import(pathToFileURL(compatibility).href);
    await applyCoreRequestCompatibility(corePath);
  }

  private async applyAddonCompatibility(name: string): Promise<void> {
    if (!["pi-mcp-adapter", "pi-llama-cpp-stats"].includes(name)) return;
    const compatibility = path.join(this.appRoot, "resources", "pi-rpc-bridge", "compatibility.js");
    const { applyAddonRequestCompatibility } = await import(pathToFileURL(compatibility).href);
    await applyAddonRequestCompatibility(name, this.store.getEffectivePackagePath(name));
  }

  private async smokeTestRuntime(): Promise<void> {
    const smokeDir = await mkdtemp(path.join(tmpdir(), "pi-desktop-update-"));
    let exitError: Error | undefined;
    const rpc = new PiRpcProcess({
      executablePath: this.runtimeExecutable,
      cliPath: this.store.getPiCliPath(),
      cwd: this.store.dataDir,
      agentDir: this.store.agentDir,
      sessionsDir: smokeDir,
      sessionId: `update-smoke-${randomUUID()}`,
      appRoot: this.appRoot,
      mcpEntryPath: path.join(this.appRoot, "node_modules", "@zavora-ai", "computer-use-mcp", "dist", "server.js"),
      mcpDirectTools: await this.store.getMcpDirectToolSelectors(),
      onEvent: () => undefined,
      onExtensionUi: () => undefined,
      onExit: (error) => { exitError = error; },
    });
    try {
      try {
        await rpc.start();
        await rpc.request("get_state", {}, 20_000);
        await rpc.request("get_extension_state", {}, 20_000);
        if (exitError) throw exitError;
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

  private runNpm(args: string[], timeoutMs = 180_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const command = npmCommand(args, this.runtimeExecutable);
      const child = spawn(command.executable, command.args, {
        cwd: this.store.runtimePackagesDir,
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
