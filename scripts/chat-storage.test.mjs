import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { portableBinaryDirectory } from "./portable-layout.mjs";
import { collectMediaGrants } from "../resources/web-access/media-grants.mjs";
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const file = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(file)) return next(file.href, context);
  }
  return next(specifier, context);
} });
const { storeChatAttachments, migrateChatFiles } = await import("../electron/chat-storage.ts");
const { chatDirectory, chatFileDirectory } = await import("../resources/pi-comfyui/lib/chat-storage.ts");
const { portableDataDirectory } = await import("../electron/portable-paths.ts");
const { generatedFile, generatedMediaResponse } = await import("../electron/generated-media.ts");
const { generatedMediaReference, parseGeneratedLink } = await import("../shared/generated-links.ts");
const { migratePortableSessions, storedSessionReference } = await import("../electron/portable-sessions.ts");
const { publishImage } = await import("../resources/pi-comfyui/lib/image-input.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=", "base64");
async function fixture(t) {
  const root = await mkdtemp("C:/AI_Temp/pi-chat-storage-");
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve("C:/AI_Temp") + path.sep)); return rm(root, { recursive: true, force: true, maxRetries:5, retryDelay:50 }); });
  const data = path.join(root, "data"); await mkdir(data); return { root, data };
}

test("flat, split, development and portable exe layouts resolve the intended data folder", () => {
  assert.equal(portableDataDirectory("C:/source", "C:/Pi/app/Pi Desktop.exe", true), path.resolve("C:/Pi/data"));
  assert.equal(portableDataDirectory("C:/source", "C:/Pi/Pi Desktop.exe", true), path.resolve("C:/Pi/data"));
  assert.equal(portableDataDirectory("C:/source", "C:/node.exe", false), path.join("C:/source", "data"));
  assert.equal(portableDataDirectory("C:/source", "C:/temp/run.exe", true, "D:/Portable"), path.join("D:/Portable", "data"));
  for (const id of ["..", "../foreign", "C:/foreign", "bad\\id", ""]) assert.throws(() => chatDirectory("C:/data", id));
});

test("clipboard input is materialized once; external files remain untouched references", async t => {
  const { root, data } = await fixture(t), external = path.join(root, "original.png"); await writeFile(external, png);
  const clipboard = { id: "one", name: "paste.png", path: "clipboard:paste.png", mimeType: "image/png", data: png.toString("base64") };
  const [saved, original] = await storeChatAttachments(data, "chat-a", [clipboard, { ...clipboard, path: external }]);
  assert.equal(path.dirname(saved.path), path.join(data, "chats", "chat-a", "chat-attachments"));
  assert.equal(original.path, external); assert.deepEqual(await readFile(external), png);
  const again = await storeChatAttachments(data, "chat-a", [clipboard]); assert.equal(again[0].path, saved.path);
  assert.equal((await readdir(path.dirname(saved.path))).length, 1);
  assert.deepEqual(await readFile(saved.path), png);
});

test("our pending upload moves into its chat without a second file", async t => {
  const { data } = await fixture(t), pending = path.join(data, "incoming-attachments", "upload.txt");
  await mkdir(path.dirname(pending)); await writeFile(pending, "uploaded");
  const [saved] = await storeChatAttachments(data, "chat-a", [{ id: "one", name: "upload.txt", path: pending }]);
  assert.equal(existsSync(pending), false); assert.equal(await readFile(saved.path, "utf8"), "uploaded");
});

test("publishing an existing image keeps its original path and creates no extra image file", async t => {
  const { root, data } = await fixture(t), original = path.join(root, "original.png"); await writeFile(original, png);
  const image = await publishImage(data, original);
  assert.equal(image.path, original); assert.equal(image.data, png.toString("base64")); assert.deepEqual(await readdir(data), []);
});

test("old generated results and run state move to proven owners; ambiguous/unreferenced files are retained", async t => {
  const { data } = await fixture(t), jobId = "a".repeat(64), owned = `${jobId}-123.flac`;
  await mkdir(path.join(data, "comfy-jobs")); await mkdir(path.join(data, "music-generation")); await mkdir(path.join(data, "runs"));
  await writeFile(path.join(data, "comfy-jobs", `${jobId}.json`), JSON.stringify({ id: jobId, owner: "chat-a" }));
  await writeFile(path.join(data, "music-generation", owned), "audio");
  await writeFile(path.join(data, "music-generation", "unassigned.flac"), "keep");
  await writeFile(path.join(data, "runs", "chat-a.json"), "run");
  const image = path.join(data, "image-generation", "old.png"); await mkdir(path.dirname(image)); await writeFile(image, png);
  const session = path.join(data, "history.jsonl"); await writeFile(session, JSON.stringify({ type: "message", message: { role: "toolResult", details: { files: [image] } } }) + "\n");
  await migrateChatFiles(data, [{ id: "chat-a", sessionFile: session }, { id: "chat-b" }]);
  assert.equal(existsSync(path.join(data, "music-generation", owned)), false);
  assert.equal(await readFile(path.join(data, "chats", "chat-a", "music-generation", owned), "utf8"), "audio");
  assert.deepEqual(await readFile(path.join(data, "chats", "chat-a", "image-generation", "old.png")), png);
  assert.equal(await readFile(path.join(data, "chats", "chat-a", "run.json"), "utf8"), "run");
  assert.equal(await readFile(path.join(data, "music-generation", "unassigned.flac"), "utf8"), "keep");
  await migrateChatFiles(data, [{ id: "chat-a" }]);
  assert.equal((await readdir(path.join(data, "chats", "chat-a", "music-generation"))).length, 1);
  assert.equal(await generatedFile(data, "music", owned), path.join(data, "chats", "chat-a", "music-generation", owned));
});

test("local histories move byte-for-byte to the owning chat without copies or context rewriting", async t => {
  const { root, data } = await fixture(t), id = "chat-a", source = path.join(data, "agent", "sessions", "--old-cwd--", `date_${id}.jsonl`);
  await mkdir(path.dirname(source), { recursive: true }); const bytes = '{"id":"chat-a","cwd":"unchanged"}\n'; await writeFile(source, bytes);
  const migrated = await migratePortableSessions(data, [{ id, sessionFile: source }], path.join(root, "global-sessions"));
  const target = path.join(data, "chats", id, "sessions", path.basename(source));
  assert.equal(migrated.conversations[0].sessionFile, target); assert.equal(existsSync(source), false);
  assert.equal(await readFile(target, "utf8"), bytes); assert.equal(migrated.copied, 0);
  assert.equal(storedSessionReference(data, target), `chats/${id}/sessions/date_${id}.jsonl`);
  assert.equal((await migratePortableSessions(data, migrated.conversations, root)).conversations[0].sessionFile, target);
});

test("chat media addresses survive installation moves and cannot collide across chats", async t => {
  const { data } = await fixture(t);
  for (const id of ["chat-a", "chat-b"]) {
    const file = path.join(data, "chats", id, "music-generation", "same.flac"); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, id);
    const reference = generatedMediaReference(file); assert.equal(reference, `${id}/music-generation/same.flac`);
    const response = await generatedMediaResponse(data, new Request(`pi-generated://music/${encodeURIComponent(reference)}`, { headers: { Range: "bytes=0-3" } }));
    assert.equal(response.status, 206); assert.equal(await response.text(), "chat");
    const parsed = parseGeneratedLink(`file:///${file.replaceAll("\\", "/")}`); assert.equal(parsed.filename, reference);
  }
  await assert.rejects(generatedFile(data, "music", "same.flac"), /неоднозначен/);
  for (const unsafe of ["../same.flac", "chat-a/../same.flac", "chat-a/music-generation/../../foreign", "chat-a/music-generation/C:/file", "chat-a//bad"])
    await assert.rejects(generatedFile(data, "music", unsafe));
});

test("a chat folder junction cannot expose foreign files through media routes", async t => {
  const { root, data } = await fixture(t), outside = path.join(root, "outside"), chats = path.join(data, "chats");
  await mkdir(path.join(outside, "music-generation"), { recursive: true }); await writeFile(path.join(outside, "music-generation", "secret.flac"), "secret"); await mkdir(chats);
  try { await symlink(outside, path.join(chats, "chat-a"), "junction"); } catch (error) { if (error.code === "EPERM") return t.skip("symlinks unavailable"); throw error; }
  await assert.rejects(generatedFile(data, "music", "chat-a/music-generation/secret.flac"), /вне data/);
});

test("remote media grants include only explicit owned-file addresses, not text or other paths", () => {
  const grants = new Set(), data = path.resolve("C:/Pi/data"), file = path.join(data, "chats", "chat-a", "music-generation", "song.flac");
  collectMediaGrants({ files: [file], text: path.join(data, "chats", "chat-b", "music-generation", "secret.flac") }, data, grants);
  assert.deepEqual([...grants], ["music/chat-a/music-generation/song.flac"]);
});

test("deleting a project chat trashes its complete own folder, never the external project", async t => {
  const { root, data } = await fixture(t), chat = { id: "chat-a", projectId: "project" }, folder = chatDirectory(data, chat.id), external = path.join(root, "project");
  await mkdir(folder, { recursive: true }); await mkdir(external); chat.sessionFile = path.join(folder, "sessions", "history.jsonl");
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8"), begin = source.indexOf("  async deleteConversation("), end = source.indexOf("  async archiveConversation", begin);
  const method = stripTypeScriptTypes(source.slice(begin, end).replace("  async deleteConversation", "async function remove"));
  const trashed = [], events = [], remove = new Function("path", "existsSync", "shell", `${method};return remove;`)(path, existsSync, { async trashItem(file) { trashed.push(file); } });
  const owner = { async stopConversation() { events.push("stop"); }, store: { getConversation: () => chat, getConversationChatDirectory: () => folder,
    getConversationDataDirectories: () => [folder], async deleteConversation() { events.push("remove-index"); } } };
  await remove.call(owner, chat.id); assert.deepEqual(trashed, [folder]); assert.deepEqual(events, ["stop", "remove-index"]); assert.equal(existsSync(external), true);
  owner.store.getConversationDataDirectories = () => [folder]; owner.store.deleteConversation = async () => assert.fail("index must survive failed trash");
  const failure = new Function("path", "existsSync", "shell", `${method};return remove;`)(path, existsSync, { async trashItem() { throw new Error("locked"); } });
  await assert.rejects(failure.call(owner, chat.id), /locked/);
});

test("packaging targets app without a command launcher and never copies or replaces data", async t => {
  const { root, data } = await fixture(t); await writeFile(path.join(data, "keep.txt"), "user data");
  assert.equal(portableBinaryDirectory(root), path.join(root, "app")); assert.equal(await readFile(path.join(data, "keep.txt"), "utf8"), "user data");
  for (const name of ["package-portable.mjs", "update-portable-fast.mjs", "portable-layout.mjs"]) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /writePortableLauncher|Start Pi Desktop\.(?:cmd|bat)/i);
  }
  const script = readFileSync(new URL("./package-portable.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /cp\(dataSource|carry portable data/); assert.match(script, /target: portableBinaryDirectory\(targetDir\)/);
});
