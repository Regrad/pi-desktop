import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks, findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { loadSkillsFromDir, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { projectDesktopServiceContext, desktopSummaryMessages } from "../resources/pi-rpc-bridge/service-context.js";
import { routeTool } from "../resources/tool-routing/index.js";
import { skillCatalogContext } from "../shared/skills.ts";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(["./atomic-state.js", "./skills-store.js", "./goal-extension.js", "./state-context.js", "../shared/goal.js", "../shared/skills.js"].includes(specifier)
    ? specifier.replace(/\.js$/, ".ts") : specifier, context);
} });
const { SkillsStore } = await import("../electron/skills-store.ts");
const { default: skillsExtension } = await import("../electron/skills-extension.ts");
hooks.deregister();

const root = path.resolve(import.meta.dirname, "..");
const content = (name, body = "Repeatable verified workflow.", extra = "") => `---\nname: ${name}\ndescription: Use for ${name} tasks.\n${extra}---\n\n${body}\n`;
async function fixture(project = true) {
  const base = await mkdtemp(path.join(tmpdir(), "pi-skills-test-"));
  const options = { agentDir: path.join(base, "agent"), cwd: path.join(base, "project"), appRoot: root, project };
  await mkdir(options.agentDir, { recursive: true });
  await mkdir(options.cwd, { recursive: true });
  // Fixtures never discover the developer's personal ~/.agents skills.
  await writeFile(path.join(options.agentDir, "settings.json"), JSON.stringify({ skills: ["-**"] }));
  const store = new SkillsStore(options);
  // Native explicit paths mirror resources discovered by Pi at startup.
  store.includeNative([store.roots.user, ...(store.roots.project ? [store.roots.project] : [])]);
  return { store, options, base };
}
async function save(store, name, scope = "user", body) {
  const catalog = await store.command({ action: "save", scope, name, expectedRevision: "", content: content(name, body) });
  return catalog.skills.find(skill => skill.name === name);
}
function harness(store, request = async () => ({})) {
  const handlers = new Map(), tools = [], sent = [];
  skillsExtension({ on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool(tool) { tools.push(tool); }, sendMessage(message, options) { sent.push({ ...message, options }); } }, store, request);
  return { tools, sent, handlers, invoke: async (name, event, ctx = { ui: { notify() {} } }) => {
    let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result;
  } };
}

test("native Pi validates bundled creator, and catalog does not contain its full instructions", async () => {
  const loaded = loadSkillsFromDir({ dir: path.join(root, "resources/skills"), source: "bundled" });
  assert.equal(loaded.skills.length, 1); assert.deepEqual(loaded.diagnostics, []);
  const { store } = await fixture();
  const catalog = await store.catalog();
  const creator = catalog.skills.find(skill => skill.name === "maintain-skills");
  assert.equal(creator.editable, false); assert.equal(creator.scope, "bundled");
  assert.doesNotMatch(skillCatalogContext(catalog), /Each skill is a folder/);
  assert.match((await store.document(creator.id)).content, /Each skill is a folder/);
});

test("create, read and revise user and project skills with conflict detection", async () => {
  const { store } = await fixture();
  for (const scope of ["user", "project"]) {
    const skill = await save(store, `test-${scope}`, scope);
    assert.equal(skill.editable, true); assert.equal(skill.scope, scope);
    const doc = await store.command({ action: "read", id: skill.id });
    assert.equal(doc.content, content(skill.name));
    const next = content(skill.name, "Changed workflow.");
    await store.command({ action: "save", scope, name: skill.name, content: next, expectedRevision: doc.skill.revision });
    await assert.rejects(store.command({ action: "save", scope, name: skill.name, content: content(skill.name, "Stale"), expectedRevision: doc.skill.revision }), /изменён/);
    assert.equal((await store.document(skill.id)).content, next);
  }
});

test("strict save validation leaves files untouched", async () => {
  const { store } = await fixture();
  for (const name of ["../outside", "a/b", "UPPER", "a--b", "con", "nul", "x".repeat(65), "", "-bad"])
    await assert.rejects(save(store, name), /Имя навыка/);
  for (const text of ["No frontmatter", content("other"), "---\nname: valid\ndescription: ''\n---\nbody", content("valid", ""), content("valid", "x", "disable-model-invocation: yes\n")])
    await assert.rejects(store.command({ action: "save", scope: "user", name: "valid", content: text, expectedRevision: "" }));
  await assert.rejects(access(path.join(store.roots.user, "valid/SKILL.md")));
});

test("project skills unavailable in a projectless chat; another project does not see them", async () => {
  const { store, options } = await fixture();
  await save(store, "project-secret", "project");
  const nextProject = path.join(options.cwd, "other"); await mkdir(nextProject);
  const other = new SkillsStore({ ...options, cwd: nextProject });
  assert.equal((await other.catalog()).skills.some(skill => skill.name === "project-secret"), false);
  const standalone = await fixture(false);
  await assert.rejects(save(standalone.store, "project-secret", "project"), /только в чате проекта/);
});

test("disable is persisted across restart; deletion requires confirmation and keeps neighboring files", async () => {
  const { store, options } = await fixture();
  const skill = await save(store, "removable");
  const neighbor = await save(store, "neighbor");
  await writeFile(path.join(path.dirname(skill.filePath), "helper.txt"), "supporting resource");
  await store.command({ action: "enable", id: skill.id, enabled: false, expectedRevision: skill.revision });
  const restored = new SkillsStore(options); restored.includeNative([store.roots.user]);
  assert.equal((await restored.catalog()).skills.find(item => item.id === skill.id).enabled, false);
  assert.equal(JSON.parse(skillCatalogContext(await restored.catalog())).skills.find(item => item.name === skill.name).enabled, false);
  await assert.rejects(store.command({ action: "delete", id: skill.id, expectedRevision: skill.revision, confirm: false }), /подтверждения/);
  await store.command({ action: "delete", id: skill.id, expectedRevision: skill.revision, confirm: true });
  await assert.rejects(access(path.dirname(skill.filePath)));
  await access(neighbor.filePath);
  assert.equal((await restored.catalog(true)).skills.some(item => item.name === skill.name), false);
});

test("bundled and addon skills are protected from overwrite and deletion", async () => {
  const { store, options, base } = await fixture();
  const addon = path.join(base, "addon"); await mkdir(path.join(addon, "skills/addon-example"), { recursive: true });
  await writeFile(path.join(addon, "package.json"), JSON.stringify({ name: "fixture-addon", pi: { skills: ["./skills"] } }));
  await writeFile(path.join(addon, "skills/addon-example/SKILL.md"), content("addon-example"));
  await writeFile(path.join(options.agentDir, "settings.json"), JSON.stringify({ packages: [addon], skills: ["-**"] }));
  const catalog = await store.catalog(true);
  for (const name of ["maintain-skills", "addon-example"]) {
    const skill = catalog.skills.find(item => item.name === name);
    assert.equal(skill.editable, false);
    await assert.rejects(store.command({ action: "delete", id: skill.id, expectedRevision: skill.revision, confirm: true }), /нельзя удалять/);
    await assert.rejects(save(store, name), /уже существует/);
    await access(skill.filePath);
  }
});

test("UTF-8 BOM and CRLF survive revision; invalid encoding is diagnosed", async () => {
  const { store } = await fixture(); const skill = await save(store, "encoded");
  await writeFile(skill.filePath, "\uFEFF" + content("encoded", "Привет").replaceAll("\n", "\r\n"));
  const doc = await store.document(skill.id);
  assert.ok(!doc.content.startsWith("\uFEFF"));
  await store.command({ action: "save", scope: "user", name: "encoded", content: content("encoded", "Обновлено"), expectedRevision: doc.skill.revision });
  const bytes = await readFile(skill.filePath); assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
  assert.ok(bytes.toString("utf8").includes("\r\nОбновлено"));
  await writeFile(skill.filePath, Buffer.from([255, 254, 1]));
  const catalog = await store.catalog(true); assert.ok(catalog.diagnostics.length > 0);
});

test("symlink skill and .pi junction cannot redirect managed writes or deletion", async () => {
  const { store, base } = await fixture();
  const outside = path.join(base, "outside"); await mkdir(outside); await writeFile(path.join(outside, "SKILL.md"), content("redirected"));
  await mkdir(store.roots.user, { recursive: true });
  await symlink(outside, path.join(store.roots.user, "redirected"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(save(store, "redirected"), /ссылкам|junction/);
  await access(path.join(outside, "SKILL.md"));
  await symlink(outside, path.join(store.roots.project, ".."), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(save(store, "project-link", "project"), /ссылкам|junction/);
});

test("concurrent UI/model edits share serialization and reject the stale revision", async () => {
  const { store, options } = await fixture(); const skill = await save(store, "concurrent");
  const other = new SkillsStore(options); other.includeNative([store.roots.user]);
  const results = await Promise.allSettled([store, other].map((instance, index) => instance.command({ action: "save", scope: "user", name: skill.name,
    expectedRevision: skill.revision, content: content(skill.name, `change ${index}`) })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
});

test("catalog updates append once, survive tool iterations and never contain full skill content", async () => {
  const { store } = await fixture(); const host = harness(store);
  const original = [{ role: "system", content: "Stable instructions" }, { role: "user", content: "Requested task" }];
  let messages = (await host.invoke("context", { messages: original })).messages;
  assert.equal(host.sent.length, 1); assert.equal(host.sent[0].options.triggerTurn, false);
  assert.deepEqual((await host.invoke("context", { messages })).messages, messages);
  const prior = projectDesktopServiceContext(messages);
  messages.push({ role: "assistant", content: [{ type: "text", text: "Verified result" }] }, { role: "user", content: "Next task" });
  const unchanged = projectDesktopServiceContext(messages);
  const skill = await save(store, "lazy", "user", "Secret full workflow, never in the catalog.");
  messages = (await host.invoke("context", { messages })).messages;
  assert.equal(host.sent.length, 2);
  const next = projectDesktopServiceContext(messages);
  assert.deepEqual(next.slice(0, -1), unchanged.slice(0, -1));
  assert.deepEqual(next.slice(0, prior.length), prior);
  assert.doesNotMatch(JSON.stringify(next), /Secret full workflow/);
  assert.match(JSON.stringify(next), /lazy/);
  await store.command({ action: "delete", id: skill.id, expectedRevision: skill.revision, confirm: true });
  messages = (await host.invoke("context", { messages })).messages;
  const latest = JSON.parse(messages.at(-1).content.split("\n")[1]);
  assert.equal(latest.skills.some(item => item.name === skill.name), false);
  assert.deepEqual((await host.invoke("context", { messages })).messages, messages);
});

test("catalog projected as metadata, restored after compaction and never a phantom user request", async () => {
  const { store } = await fixture(); const host = harness(store);
  const summary = { role: "compactionSummary", summary: "The verified user task", timestamp: 1 };
  const messages = (await host.invoke("context", { messages: [summary] })).messages;
  const projected = projectDesktopServiceContext(messages);
  assert.equal(projected.length, 1); assert.equal(projected[0].role, "compactionSummary");
  assert.match(projected[0].summary, /metadata.*not a user request/s);
  assert.ok(!JSON.stringify(projected).includes("Create files with the normal write tool"));
  const old = process.env.PI_DESKTOP_CONVERSATION_ID; process.env.PI_DESKTOP_CONVERSATION_ID = "fixture";
  try { assert.equal(desktopSummaryMessages(messages).at(-1).desktopApplicationState, true); }
  finally { if (old === undefined) delete process.env.PI_DESKTOP_CONVERSATION_ID; else process.env.PI_DESKTOP_CONVERSATION_ID = old; }
});

test("new skills can be invoked without reload; disabled/missing commands fail closed", async () => {
  const { store } = await fixture(); const host = harness(store);
  const skill = await save(store, "new-skill", "user", "Specific task instructions.");
  const invoked = await host.invoke("input", { text: "/skill:new-skill Perform the task", images: ["image"] });
  assert.equal(invoked.action, "transform"); assert.match(invoked.text, /Specific task instructions/); assert.ok(invoked.text.endsWith("Perform the task"));
  assert.deepEqual(invoked.images, ["image"]);
  await store.command({ action: "enable", id: skill.id, enabled: false, expectedRevision: skill.revision });
  const notices = [];
  for (const name of ["new-skill", "missing"]) {
    const result = await host.invoke("input", { text: `/skill:${name}` }, { ui: { notify(message) { notices.push(message); } } });
    assert.equal(result.action, "handled");
  }
  assert.equal(notices.length, 2);
  assert.equal((await host.invoke("input", { text: "Ordinary task" })).action, "continue");
});

test("catalog never reaches the forced leading prompt, tool schema remains deferred and unchanged", async () => {
  const { store } = await fixture(); const host = harness(store);
  const schema = JSON.stringify(host.tools[0].parameters);
  const event = { systemPromptOptions: { skills: [] }, get systemPrompt() { return `Stable instructions${JSON.stringify(this.systemPromptOptions.skills)}`; } };
  const initial = await host.invoke("before_agent_start", event);
  const skill = await save(store, "dynamic");
  event.systemPromptOptions.skills = [{ name: skill.name, filePath: skill.filePath, description: skill.description }];
  const updated = await host.invoke("before_agent_start", event);
  assert.equal(initial.systemPrompt, updated.systemPrompt);
  assert.equal(JSON.stringify(host.tools[0].parameters), schema);
  const previous = process.env.PI_DESKTOP_TOOL_ROUTING; process.env.PI_DESKTOP_TOOL_ROUTING = "1";
  try { const tool = routeTool(host.tools[0], "skills-extension"); assert.equal(tool.exposure, "deferred"); assert.equal(tool.namespace.name, "Skills"); }
  finally { if (previous === undefined) delete process.env.PI_DESKTOP_TOOL_ROUTING; else process.env.PI_DESKTOP_TOOL_ROUTING = previous; }
  const rpcSource = await readFile(path.join(root, "electron/pi-rpc-process.ts"), "utf8");
  assert.ok(rpcSource.indexOf('args.push("--extension", this.options.skillsExtensionPath)') < rpcSource.indexOf('"builtin:codemode"'));
});

test("ordinary file edits update catalog after the tool boundary without extra model tools", async () => {
  const { store } = await fixture(); const host = harness(store); const skill = await save(store, "editable");
  const initial = await store.catalog();
  await writeFile(skill.filePath, content(skill.name, "Ordinary exact edit"));
  await host.invoke("tool_result", { toolName: "edit", isError: false });
  const next = await store.catalog(); assert.notEqual(next.revision, initial.revision);
  assert.equal(host.tools.length, 1); assert.equal(host.tools[0].name, "manage_skills");
});

test("a corrupted disabled-state file revokes historical skills once, then restores on recovery", async () => {
  const { store, options } = await fixture(); const host = harness(store); await save(store, "available");
  let messages = (await host.invoke("context", { messages: [{ role: "user", content: "Task" }] })).messages;
  const before = host.sent.length;
  await writeFile(path.join(options.agentDir, "desktop-skills.json"), "malformed"); store.invalidate();
  messages = (await host.invoke("context", { messages })).messages;
  assert.match(messages.at(-1).content, /catalog unavailable; do not use earlier/);
  assert.equal(host.sent.length, before + 1);
  assert.deepEqual((await host.invoke("context", { messages })).messages, messages);
  assert.equal(host.sent.length, before + 1);
  await writeFile(path.join(options.agentDir, "desktop-skills.json"), '{"disabled":[]}'); store.invalidate();
  messages = (await host.invoke("context", { messages })).messages;
  assert.match(messages.at(-1).content, /available/);
  assert.doesNotMatch(messages.at(-1).content, /unavailable/);
});

test("native Pi prompt runner plus actual OpenAI serializer preserve the head and earlier turns", async () => {
  const { store, options } = await fixture(); const host = harness(store);
  const errors = [];
  const runner = new ExtensionRunner([{ path: "skills", handlers: host.handlers }, { path: "later-desktop-extension", handlers: new Map([
    ["before_agent_start", [event => ({ systemPrompt: `${event.systemPrompt}\nStable desktop policy.` })]],
  ]) }], {}, options.cwd, {}, {});
  runner.onError(error => errors.push(error));
  const base = { cwd: options.cwd, customPrompt: "Stable system instructions.", selectedTools: ["read", "codemode"] };
  const initial = (await runner.emitBeforeAgentStart({ messageType: "user", prompt: "Task" }, { ...base, skills: [] })).systemPromptOptions.forceSystemPrompt;
  const skill = await save(store, "serializer-check");
  const next = (await runner.emitBeforeAgentStart({ messageType: "user", prompt: "Next task" }, { ...base, skills: [{ name: skill.name, filePath: skill.filePath,
    description: skill.description, baseDir: path.dirname(skill.filePath), sourceInfo: {}, disableModelInvocation: false }] })).systemPromptOptions.forceSystemPrompt;
  assert.equal(initial, next); assert.deepEqual(errors, []);
  const providerRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(path.join(root, "node_modules/@earendil-works/pi-coding-agent/package.json")).href));
  const { convertMessages } = await import(pathToFileURL(path.join(providerRoot, "dist/api/openai-completions.js")));
  const { normalizeContext } = await import(pathToFileURL(path.join(providerRoot, "dist/utils/transcript.js")));
  const model = { id: "qwen3.8-flash-next-ud-q4-k-xl", name: "Fixture", provider: "llama-cpp", api: "openai-completions", input: ["text"], reasoning: true };
  let history = [{ role: "user", content: "First request", timestamp: 1 }];
  history = (await host.invoke("context", { messages: history })).messages;
  history.push({ role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "stop", timestamp: 2,
    content: [{ type: "text", text: "Verified answer" }] }, { role: "user", content: "Next request", timestamp: 3 });
  const convert = messages => convertMessages(model, normalizeContext({ systemPrompt: initial, tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    messages: projectDesktopServiceContext(messages) }), { supportsDeveloperRole: false, supportsMidConvoSystemMessages: false });
  const before = convert(history);
  await store.command({ action: "enable", id: skill.id, enabled: false, expectedRevision: skill.revision });
  const after = convert((await host.invoke("context", { messages: history })).messages);
  assert.deepEqual(after.slice(0, -1), before.slice(0, -1));
  assert.equal(after[0].role, "system"); assert.equal(after[0].content, before[0].content);
  assert.equal(after.filter(message => message.role === "user").length, 2);
  assert.match(JSON.stringify(after.at(-1)), /enabled.*false/);
});
