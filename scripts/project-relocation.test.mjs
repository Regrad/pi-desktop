import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const file = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(file)) return next(file.href, context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith(".ts")) return result;
  const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
  return { ...result, format: "module", source: stripTypeScriptTypes(source, { mode: "transform", sourceUrl: url }) };
} });

const { DataStore } = await import("../electron/data-store.ts");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-project-relocation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DataStore(root, process.cwd(), process.execPath);
  await store.initialize({ refreshSessions: false });
  return { root, store };
}

test("a project whose folder disappeared is reported and a healthy one is not", async t => {
  const { root, store } = await fixture(t);
  const alive = path.join(root, "alive");
  await mkdir(alive, { recursive: true });
  const textFile = path.join(root, "notes.txt");
  await writeFile(textFile, "не папка");
  const healthy = await store.addProject("Живой", [alive]);
  const moved = await store.addProject("Уехавший", [path.join(root, "gone")]);
  const file = await store.addProject("Файл", [textFile]);

  const byId = new Map((await store.projectLocationIssues()).map((issue) => [issue.projectId, issue]));
  assert.deepEqual([...byId.keys()].sort(), [moved.id, file.id].sort());
  assert.ok(!byId.has(healthy.id), "a folder that exists stays quiet");
  assert.equal(byId.get(moved.id).name, "Уехавший");
  assert.equal(byId.get(moved.id).unavailable[0].reason, "missing");
  assert.equal(byId.get(file.id).unavailable[0].reason, "unavailable", "a file is not a working folder");
});

test("moving the root follows nested folders, leaves foreign ones and checks the target", async t => {
  const { root, store } = await fixture(t);
  const old = path.join(root, "old", "project");
  const nested = path.join(old, "packages", "server");
  const outside = path.join(root, "shared-lib");
  await mkdir(nested, { recursive: true });
  const project = await store.addProject("Проект", [old, nested, outside]);
  const target = path.join(root, "moved", "project");
  await mkdir(target, { recursive: true });

  await assert.rejects(() => store.moveProjectRoot(project.id, old, path.join(root, "nowhere")),
    /Указанной папки не существует/);
  await assert.rejects(() => store.moveProjectRoot(project.id, path.join(root, "stranger"), target),
    /не входит в проект/);

  await store.moveProjectRoot(project.id, old, target);
  const updated = store.getProject(project.id);
  assert.equal(updated.path, target, "the primary folder follows");
  assert.deepEqual(updated.paths, [target, path.join(target, "packages", "server"), outside],
    "nested folders move with the project, unrelated ones stay where they are");

  const elsewhere = path.join(root, "second", "move");
  await store.moveProjectRoot(project.id, target, elsewhere, true);
  assert.equal(store.getProject(project.id).path, elsewhere,
    "a verified folder is accepted without checking this computer");
});

test("the folder list can be edited by hand and always keeps a primary folder", async t => {
  const { root, store } = await fixture(t);
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const third = path.join(root, "third");
  for (const folder of [first, second, third]) await mkdir(folder, { recursive: true });
  const project = await store.addProject("Проект", [first, second]);

  await assert.rejects(() => store.setProjectFolders(project.id, []), /хотя бы одну папку/);

  await store.setProjectFolders(project.id, [second, third]);
  assert.equal(store.getProject(project.id).path, second,
    "when the primary folder is removed the next one takes over");

  await store.setProjectFolders(project.id, [third, second]);
  assert.equal(store.getProject(project.id).path, second,
    "reordering keeps the primary folder until it is dropped");
});

test("chats of the project start in the new folder and refuse to run without it", async t => {
  const { root, store } = await fixture(t);
  const folder = path.join(root, "project");
  await mkdir(folder, { recursive: true });
  const project = await store.addProject("Проект", [folder]);
  const chat = await store.createConversation(project.id);
  assert.equal(await store.getConversationWorkingDirectory(chat), folder);

  // Индекс сессий привязан к путям, поэтому перенос обязан его сбросить.
  store.state.sessionIndex = { [project.id]: "stamp" };
  const target = path.join(root, "new-project");
  await mkdir(target, { recursive: true });
  await store.moveProjectRoot(project.id, folder, target);
  assert.equal(store.state.sessionIndex[project.id], undefined, "the session index is rebuilt");
  assert.equal(await store.getConversationWorkingDirectory(chat), target);
  await store.assertProjectAvailable(project.id);
  await store.assertProjectAvailable(undefined);

  await rm(target, { recursive: true });
  await assert.rejects(() => store.assertProjectAvailable(project.id), /Папка проекта не найдена/);
  await store.assertProjectAvailable(undefined);
});

test("reopening the store keeps the relocated paths", async t => {
  const { root, store } = await fixture(t);
  const old = path.join(root, "before");
  await mkdir(old, { recursive: true });
  const project = await store.addProject("Проект", [old]);
  const target = path.join(root, "after");
  await mkdir(target, { recursive: true });
  await store.moveProjectRoot(project.id, old, target);

  const reopened = new DataStore(root, process.cwd(), process.execPath);
  await reopened.initialize({ refreshSessions: false });
  assert.equal(reopened.getProject(project.id).path, target);
  assert.deepEqual(await reopened.projectLocationIssues(), []);
});
