import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { cancelWorkflowJob, collectWorkflowJob, listWorkflowJobs, waitWorkflowJob, workflowJobStatus, workflowJobSummary } from "../../lib/workflow-jobs.js";

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "comfyui_job", label: "Задание ComfyUI",
    description: "List/check/wait/cancel/collect persistent jobs from comfyui_run_workflow. list recovers this chat's job IDs after restart. wait observes the SAME job for up to wait_seconds (default 30, max 300); still-running is not a failure and requires no regeneration. Stopping a wait does not cancel GPU work; cancel explicitly stops only this job. results downloads files, publishes image/audio/video/GLB previews and returns reports; paginate nextOffset. Unknown outcome means check the server, not start another generation.",
    parameters: Type.Object({
      action: Type.Union(["list", "status", "wait", "cancel", "results"].map(value => Type.Literal(value))), job_id: Type.Optional(Type.String()),
      wait_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 300 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params, signal, update) {
      if (params.action === "list") return { content: [{ type: "text" as const, text: JSON.stringify(await listWorkflowJobs(dataDir, params.offset, params.limit)) }], details: {} };
      if (!params.job_id) throw new Error("Нужен job_id из запуска или списка заданий");
      if (params.action !== "results") {
        const job = params.action === "cancel" ? await cancelWorkflowJob(dataDir, params.job_id, signal)
          : params.action === "wait" ? await waitWorkflowJob(dataDir, params.job_id, params.wait_seconds, signal, text => update?.({ content: [{ type: "text", text }], details: {} }))
          : await workflowJobStatus(dataDir, params.job_id, signal);
        return { content: [{ type: "text", text: JSON.stringify(workflowJobSummary(job)) }], details: {}, ...(job.status === "failed" ? { isError: true } : {}) };
      }
      const result = await collectWorkflowJob(dataDir, params.job_id, params, signal);
      const images = result.files.filter(file => file.type === "image" && file.data);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...result, job: workflowJobSummary(result.job), files: result.files.map(({ data: _data, ...file }) => file) }) },
          ...images.map(file => ({ type: "image" as const, data: file.data!, mimeType: file.mimeType }))],
        details: { jobId: result.job.id, files: [...images.map(file => file.path), ...result.files.filter(file => !images.includes(file)).map(file => file.path)],
          media: result.files.filter(file => ["audio", "video", "model3d", "file"].includes(file.type)).map(({ data: _data, ...file }) => file) },
        ...(result.job.status === "failed" ? { isError: true } : {}),
      };
    },
  });
}
