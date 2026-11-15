import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { sortProjects, projectActivityAt, PROJECT_SORT_MODES } from "../src/project-sort.ts";

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

const project = (id, name, addedAt) => ({
  id, name, path: `C:/p/${id}`, paths: [`C:/p/${id}`], addedAt, lastOpenedAt: addedAt,
});
const chat = (projectId, updatedAt, extra = {}) => ({
  id: `${projectId}-${updatedAt}`, projectId, title: "chat", createdAt: updatedAt, updatedAt,
  status: "idle", ...extra,
});

const projects = [
  project("quiet", "Альфа", "2026-01-05T00:00:00.000Z"),
  project("busy", "Бета", "2026-02-05T00:00:00.000Z"),
  project("empty", "Якорь", "2026-03-05T00:00:00.000Z"),
];
const chats = [
  chat("busy", "2026-05-01T00:00:00.000Z"),
  chat("quiet", "2026-06-01T00:00:00.000Z"),
  // An archived chat must not keep an idle project on top.
  chat("quiet", "2026-09-01T00:00:00.000Z", { archived: true }),
];

const names = list => list.map(item => item.name);

test("last activity orders projects by their newest non-archived chat", () => {
  assert.deepEqual(names(sortProjects(projects, chats, "activity")), ["Альфа", "Бета", "Якорь"]);
  // Without chats a project is placed by the day it appeared.
  assert.deepEqual(names(sortProjects(projects, [], "activity")), ["Якорь", "Бета", "Альфа"]);
  assert.equal(projectActivityAt(projects[2], chats), "2026-03-05T00:00:00.000Z");
});

test("alphabetical order follows Russian collation and ignores case", () => {
  const list = [project("a", "яндекс", "2026-01-01T00:00:00.000Z"), project("b", "Абв", "2026-01-02T00:00:00.000Z"),
    project("c", "Ёлка", "2026-01-03T00:00:00.000Z"), project("d", "Елка", "2026-01-04T00:00:00.000Z")];
  assert.deepEqual(names(sortProjects(list, [], "alphabet")), ["Абв", "Елка", "Ёлка", "яндекс"]);
});

test("creation order is newest first and stays stable for identical timestamps", () => {
  const same = [project("x", "Икс", "2026-04-01T00:00:00.000Z"), project("y", "Ы", "2026-04-01T00:00:00.000Z")];
  assert.deepEqual(names(sortProjects(same, [], "created")), ["Икс", "Ы"]);
  assert.deepEqual(names(sortProjects(projects, chats, "created")), ["Якорь", "Бета", "Альфа"]);
});

test("sorting never reorders the source arrays and offers exactly three modes", () => {
  const snapshot = [...projects];
  sortProjects(projects, chats, "alphabet");
  sortProjects(projects, chats, "activity");
  assert.deepEqual(projects, snapshot);
  assert.deepEqual([...PROJECT_SORT_MODES], ["activity", "alphabet", "created"]);
});
