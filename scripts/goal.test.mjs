import test from "node:test";
import assert from "node:assert/strict";
import { applyGoalReport, settleGoal, goalPrompt, visibleGoalText } from "../shared/goal.ts";
import goalExtension from "../electron/goal-extension.ts";

const goal = () => ({ id: "test", objective: "Fix the bug", criteria: "Regression test passes", status: "active",
  progress: "", evidence: "", steps: 1, maxSteps: 10, stalledSteps: 0, updatedAt: "" });

test("hides controller context in chat without changing ordinary user text", () => {
  const prompt = goalPrompt({ ...goal(), id: "11111111-1111-4111-8111-111111111111" });
  assert.equal(visibleGoalText(`My message\n\n${prompt}`), "My message");
  assert.equal(visibleGoalText("My message"), "My message");
});

test("accepts structured progress and completion with evidence", () => {
  const current = goal();
  const updated = applyGoalReport(current, { goalId: "test", status: "complete", progress: "Fixed", evidence: "Regression test passed" });
  assert.equal(updated.status, "complete");
  assert.equal(current.status, "active");
});
test("ignores stale, paused, malformed and unverified reports", () => {
  for (const report of [null, {}, { goalId: "old", status: "complete", progress: "Done", evidence: "test" },
    { goalId: "test", status: "complete", progress: "Done", evidence: " " }]) {
    const current = goal(); assert.equal(applyGoalReport(current, report), current);
  }
  const paused = { ...goal(), status: "paused" };
  assert.equal(applyGoalReport(paused, { goalId: "test", status: "active", progress: "Continue", evidence: "" }), paused);
});
test("pauses after three stages without reported progress", () => {
  let current = goal();
  for (let i = 0; i < 3; i++) current = settleGoal(current, "");
  assert.equal(current.status, "paused");
});
test("new progress resets stall count and stage cap still wins", () => {
  assert.equal(settleGoal({ ...goal(), stalledSteps: 2, progress: "Tests added" }, "").stalledSteps, 0);
  assert.equal(settleGoal({ ...goal(), steps: 10, progress: "More work" }, "").status, "paused");
});
test("settling cannot reactivate completed or blocked goals", () => {
  for (const status of ["complete", "blocked", "paused"]) {
    const current = { ...goal(), status }; assert.equal(settleGoal(current, ""), current);
  }
});
test("continuation supplies criteria, progress and permission boundaries", () => {
  const prompt = goalPrompt(goal());
  for (const text of ["test", "Regression test passes", "desktop_goal_report", "permissions", "blocked"]) assert.ok(prompt.includes(text));
});
test("native extension produces the structured report consumed by the shell", async () => {
  let tool;
  goalExtension({ registerTool(value) { tool = value; } });
  assert.equal(tool.name, "desktop_goal_report");
  const report = { goalId: "test", status: "complete", progress: "Fixed", evidence: "Verified" };
  const result = await tool.execute("call", report);
  assert.equal(applyGoalReport(goal(), result.details.desktopGoalReport).status, "complete");
  await assert.rejects(tool.execute("call", { ...report, evidence: "" }));
});
