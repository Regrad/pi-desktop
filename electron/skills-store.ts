import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { DefaultPackageManager, SettingsManager, loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { DesktopSkill, SkillDocument, SkillsCatalog, SkillsCommand } from "../shared/skills.js";
import { atomicStateWrite } from "./atomic-state.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const queues = new Map<string, Promise<unknown>>();
function validName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 64 || !namePattern.test(value) || reservedName.test(value))
    throw new Error("Имя навыка: до 64 латинских строчных букв, цифр и одиночных дефисов; без системных имён Windows.");
}
function decode(bytes: Uint8Array): string { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
async function rejectTemporaryLink(destination: string) {
  try { const info = await lstat(`${destination}.tmp`); if (info.isSymbolicLink() || !info.isFile()) throw new Error("Временный файл настроек не является обычным файлом."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function validate(content: string, name: string) {
  validName(name);
  if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content) > 256 * 1024)
    throw new Error("SKILL.md должен содержать инструкции в UTF-8 и быть не больше 256 КБ.");
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
  if (frontmatter.name !== name) throw new Error("Поле name в YAML должно совпадать с именем папки навыка.");
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim() || frontmatter.description.length > 1024)
    throw new Error("Нужно описание description длиной от 1 до 1024 символов.");
  if (frontmatter["disable-model-invocation"] !== undefined && typeof frontmatter["disable-model-invocation"] !== "boolean")
    throw new Error("disable-model-invocation должно быть true или false.");
  if (!body.trim()) throw new Error("Добавьте инструкции после YAML-заголовка.");
}

/** Native Pi discovery without loading extensions, installing packages or rebuilding a session. */
export class SkillsStore {
  private cache?: { at: number; value: SkillsCatalog };
  private pending?: Promise<SkillsCatalog>;
  private nativePaths: string[] = [];
  readonly roots: { user: string; project?: string };
  private readonly settingsPath: string;
  private readonly options: { cwd: string; agentDir: string; appRoot: string; project?: boolean };
  constructor(options: { cwd: string; agentDir: string; appRoot: string; project?: boolean }) {
    this.options = options;
    this.roots = { user: path.join(options.agentDir, "skills"),
      ...(options.project ? { project: path.join(options.cwd, ".pi", "skills") } : {}) };
    this.settingsPath = path.join(options.agentDir, "desktop-skills.json");
  }
  includeNative(paths: string[]) {
    const next = [...new Set(paths)].sort();
    if (JSON.stringify(next) !== JSON.stringify(this.nativePaths)) { this.nativePaths = next; this.cache = undefined; }
  }
  invalidate() { this.cache = undefined; }
  private async disabled(): Promise<string[]> {
    try {
      const value = JSON.parse(await readFile(this.settingsPath, "utf8"));
      if (!Array.isArray(value.disabled) || value.disabled.some((id: unknown) => typeof id !== "string")) throw new Error("Неверный формат.");
      return value.disabled;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Не удалось прочитать настройки навыков. Включение и отключение не изменено.", { cause: error });
    }
  }
  private scope(file: string): DesktopSkill["scope"] {
    for (const scope of ["project", "user"] as const) {
      const root = this.roots[scope];
      if (root && path.relative(root, file).split(path.sep).length === 2 && path.basename(file) === "SKILL.md"
        && path.dirname(path.dirname(file)) === root) return scope;
    }
    return path.relative(path.join(this.options.appRoot, "resources", "skills"), file).startsWith("..") ? "external" : "bundled";
  }
  async catalog(refresh = false): Promise<SkillsCatalog> {
    if (!refresh && this.cache && Date.now() - this.cache.at < 1000) return this.cache.value;
    if (this.pending) return this.pending;
    this.pending = this.scan();
    try { const value = await this.pending; this.cache = { at: Date.now(), value }; return value; }
    finally { this.pending = undefined; }
  }
  private async scan(): Promise<SkillsCatalog> {
    const settings = SettingsManager.create(this.options.cwd, this.options.agentDir);
    // Skip missing packages; skill discovery never downloads or runs their code.
    const resolved = await new DefaultPackageManager({ cwd: this.options.cwd, agentDir: this.options.agentDir, settingsManager: settings }).resolve(async () => "skip");
    const paths = resolved.skills.filter(item => item.enabled).map(item => item.path);
    paths.push(...this.nativePaths, path.join(this.options.appRoot, "resources", "skills"));
    const result = loadSkills({ cwd: this.options.cwd, agentDir: this.options.agentDir, includeDefaults: false, skillPaths: paths });
    const disabled = new Set(await this.disabled());
    const skills: DesktopSkill[] = [];
    const diagnostics = result.diagnostics.map(item => `${item.path ?? ""}: ${item.message}`);
    for (const skill of result.skills) {
      try {
        const bytes = await readFile(skill.filePath);
        const content = decode(bytes);
        const scope = this.scope(skill.filePath);
        const id = hash(path.resolve(skill.filePath).toLowerCase());
        let editable = scope === "user" || scope === "project";
        if (editable) {
          try { await this.safeManagedPath(scope as "user" | "project", path.basename(skill.baseDir), false); }
          catch { editable = false; }
        }
        const warnings = result.diagnostics.filter(item => item.path === skill.filePath).map(item => item.message);
        try { validate(content, path.basename(skill.baseDir)); }
        catch (error) { warnings.push(String((error as Error).message)); }
        skills.push({ id, name: skill.name, description: skill.description, filePath: skill.filePath, scope, editable,
          enabled: !disabled.has(id), automatic: !skill.disableModelInvocation, revision: hash(bytes), warnings: [...new Set(warnings)] });
      } catch (error) { diagnostics.push(`${skill.filePath}: ${String((error as Error).message)}`); }
    }
    return { skills, diagnostics, roots: this.roots,
      revision: hash(JSON.stringify(skills.map(({ id, name, description, revision, enabled, automatic }) => ({ id, name, description, revision, enabled, automatic })))) };
  }
  private async safeManagedPath(scope: "user" | "project", name: string, create: boolean): Promise<string> {
    validName(name);
    const root = this.roots[scope];
    if (!root) throw new Error("Навыки проекта доступны только в чате проекта.");
    // Check every component below the trusted agent/project directory, not only the final file.
    const base = scope === "user" ? this.options.agentDir : this.options.cwd;
    const components = path.relative(base, path.join(root, name, "SKILL.md")).split(path.sep);
    let current = base;
    for (const component of components) {
      current = path.join(current, component);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error("Навыки по ссылкам и junction нельзя изменять из панели.");
        if (component !== "SKILL.md" && !info.isDirectory()) throw new Error("Ожидалась папка навыка.");
        if (component === "SKILL.md" && !info.isFile()) throw new Error("Ожидался обычный SKILL.md.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error; }
    }
    if (!create) {
      const actualRoot = await realpath(root);
      const actualFile = await realpath(current);
      const relative = path.relative(actualRoot, actualFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Путь вышел за папку навыков.");
    }
    return current;
  }
  async document(id: string): Promise<SkillDocument> {
    const skill = (await this.catalog(true)).skills.find(item => item.id === id);
    if (!skill) throw new Error("Навык не найден. Обновите список.");
    const bytes = await readFile(skill.filePath);
    if (bytes.length > 256 * 1024) throw new Error("SKILL.md больше 256 КБ. Сократите инструкции или вынесите подробности в отдельные ресурсы.");
    return { skill: { ...skill, revision: hash(bytes) }, content: decode(bytes) };
  }
  async command(command: SkillsCommand): Promise<SkillsCatalog | SkillDocument | { valid: boolean; errors: string[] }> {
    if (!command || typeof command !== "object") throw new Error("Нужны параметры навыка.");
    if (command.action === "list" || command.action === "refresh") return this.catalog(true);
    if (command.action === "read") return this.document(command.id);
    if (command.action === "validate") {
      const doc = await this.document(command.id);
      try { validate(doc.content, path.basename(path.dirname(doc.skill.filePath))); return { valid: true, errors: [] }; }
      catch (error) { return { valid: false, errors: [(error as Error).message] }; }
    }
    // All host-side writes share a queue across chats and UI/model callers.
    const previous = queues.get(this.settingsPath) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.mutate(command));
    queues.set(this.settingsPath, pending);
    try { return await pending; }
    finally { if (queues.get(this.settingsPath) === pending) queues.delete(this.settingsPath); }
  }
  private async mutate(command: SkillsCommand): Promise<SkillsCatalog> {
    if (command.action === "save") {
      validate(command.content, command.name);
      const target = await this.safeManagedPath(command.scope, command.name, true);
      let original: Buffer | undefined;
      try { original = await readFile(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if ((original ? hash(original) : "") !== command.expectedRevision) throw new Error("Навык изменён. Откройте актуальную версию перед сохранением.");
      const catalog = await this.catalog(true);
      if (!original && catalog.skills.some(skill => skill.name === command.name)) throw new Error("Навык с таким именем уже существует. Выберите другое имя.");
      const existing = original && catalog.skills.find(skill => path.resolve(skill.filePath) === path.resolve(target));
      if (original && !existing?.editable) throw new Error("Этот навык защищён или некорректен; исправьте файл обычным редактором.");
      await mkdir(path.dirname(target), { recursive: true });
      await this.safeManagedPath(command.scope, command.name, true);
      const oldText = original ? decode(original) : "";
      const newline = oldText.includes("\r\n") ? "\r\n" : "\n";
      const content = command.content.replace(/^\uFEFF/, "").replace(/\r?\n/g, newline);
      const bom = original?.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? "\uFEFF" : "";
      // Check the temporary file too: atomicStateWrite must not follow a planted symlink.
      try { await lstat(`${target}.tmp`); throw new Error("Временный файл уже существует; проверьте его перед повторным сохранением."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await atomicStateWrite(target, bom + content);
    } else if (command.action === "enable" || command.action === "delete") {
      const doc = await this.document(command.id);
      if (doc.skill.revision !== command.expectedRevision) throw new Error("Навык изменён. Обновите список и повторите действие.");
      if (command.action === "delete") {
        if (command.confirm !== true) throw new Error("Удаление требует явного подтверждения пользователя.");
        if (!doc.skill.editable) throw new Error("Встроенные и внешние навыки нельзя удалять из панели.");
        const target = await this.safeManagedPath(doc.skill.scope as "user" | "project", path.basename(path.dirname(doc.skill.filePath)), false);
        // Exact validated skill folder only; user confirmed removal of its supporting resources too.
        await rm(path.dirname(target), { recursive: true });
      } else if (typeof command.enabled !== "boolean") throw new Error("Нужно enabled: true или false.");
      const disabled = new Set(await this.disabled());
      if (command.action === "enable" && !command.enabled) disabled.add(command.id); else disabled.delete(command.id);
      await mkdir(this.options.agentDir, { recursive: true });
      await rejectTemporaryLink(this.settingsPath);
      await atomicStateWrite(this.settingsPath, JSON.stringify({ disabled: [...disabled].sort() }, null, 2) + "\n");
    } else throw new Error("Неизвестное действие с навыком.");
    this.cache = undefined;
    return this.catalog(true);
  }
}
