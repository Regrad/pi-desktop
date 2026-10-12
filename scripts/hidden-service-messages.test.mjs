import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const start = source.indexOf("function buildTranscriptDisplay(");
const end = source.indexOf("\nfunction ", start + 1);
assert.ok(start >= 0 && end > start);
const build = new Function("hasAnswerText", "splitThinkingFromAnswer", "messageKey",
  `${stripTypeScriptTypes(source.slice(start, end))}; return buildTranscriptDisplay;`
)(() => true, item => ({ item }), (_message, index) => String(index));
const item = (role, extra = {}) => ({ kind: "message", sourceIndex: 0, message: { role, ...extra } });

test("hidden service messages never enter transcript rows or virtual layout", () => {
  const user = item("user", { content: "Continue" });
  const answer = item("assistant", { content: "Answer" });
  const hidden = ["desktop_goal_state", "desktop_plan_state", "desktop_goal_continuation", "desktop_plan_continuation", "other"]
    .map(customType => item("custom", { customType, display: false, content: "service state" }));
  assert.deepEqual(build([user, ...hidden, answer]), build([user, answer]));
});

test("visible custom messages remain visible and hidden service messages do not split tool folds", () => {
  const visible = item("custom", { display: true, content: "Notice" });
  assert.equal(build([visible])[0].item, visible);
  const tool = item("toolResult"), answer = item("assistant");
  const hidden = item("custom", { display: false });
  assert.deepEqual(build([tool, hidden, answer]), build([tool, answer]));
});
