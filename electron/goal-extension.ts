import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Loaded by the shell through Pi's public extension API, never installed into user addons.
export default function goalExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "desktop_goal_report",
    label: "Прогресс цели",
    description: "Report progress for an explicitly active Pi Desktop goal. Does not create goals or grant permission. Complete requires evidence covering all acceptance criteria.",
    parameters: Type.Object({
      goalId: Type.String(),
      status: Type.Union([Type.Literal("active"), Type.Literal("blocked"), Type.Literal("complete")]),
      progress: Type.String({ minLength: 1, maxLength: 8000 }),
      evidence: Type.String({ maxLength: 8000 }),
    }),
    async execute(_id, report) {
      if (report.status === "complete" && !report.evidence.trim()) throw new Error("Completion requires verification evidence.");
      return {
        content: [{ type: "text", text: "Goal report submitted to the desktop. Reports for inactive or outdated goals are ignored." }],
        details: { desktopGoalReport: report },
      };
    },
  });
}
