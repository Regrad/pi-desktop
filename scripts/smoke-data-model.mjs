import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DataStore } from "../dist-electron/electron/data-store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-data-model-"));
const dataDir = path.join(testRoot, "data");
const legacyProjectPath = path.join(testRoot, "legacy-project");
await mkdir(dataDir, { recursive: true });
await mkdir(legacyProjectPath, { recursive: true });
await writeFile(
  path.join(dataDir, "desktop-state.json"),
  JSON.stringify({
    version: 1,
    projects: [{
      id: "legacy-project",
      name: "Legacy",
      path: legacyProjectPath,
      addedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    }],
    conversations: [],
  }),
  "utf8",
);

try {
  const store = new DataStore(dataDir, root);
  await store.initialize();
  const migrated = store.getProject("legacy-project");
  assert.deepEqual(migrated.paths, [legacyProjectPath]);

  const standalone = await store.createConversation();
  assert.equal(standalone.projectId, undefined);
  const standaloneCwd = await store.getConversationWorkingDirectory(standalone);
  assert.equal(standaloneCwd, path.join(dataDir, "chats", standalone.id, "workspace"));

  const folderA = path.join(testRoot, "folder-a");
  const folderB = path.join(testRoot, "folder-b");
  await mkdir(folderA);
  await mkdir(folderB);
  const project = await store.addProject("Multi", [folderA, folderB]);
  assert.deepEqual(project.paths, [folderA, folderB]);
  assert.equal(project.path, folderA);
  const projectChat = await store.createConversation(project.id);
  assert.equal(await store.getConversationWorkingDirectory(projectChat), folderA);

  process.stdout.write("Data model smoke test passed.\n");
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
