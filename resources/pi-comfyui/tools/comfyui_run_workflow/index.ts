import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { compileDesktopWorkflow } from "../../lib/desktop-compiler.js";
import { submitWorkflow, workflowJobSummary } from "../../lib/workflow-jobs.js";

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "comfyui_run_workflow", label: "Запуск workflow ComfyUI",
    description: "Run a saved workflow after comfyui_workflows inspect. Pass its current revision and only needed node/input value changes; other saved defaults and connections remain unchanged. files uploads original absolute input paths and binds returned server names automatically. request_key identifies ONE intended generation: reuse it only to recover that same request, never to create another variant. Returns a persistent job_id without waiting for GPU work. Use comfyui_job to wait, collect results, or cancel. An unknown submission outcome must be checked, not resubmitted with a new key. Installing nodes/models or adding cloud access is a separate user decision.",
    parameters: Type.Object({
      workflow_id: Type.String(), revision: Type.String(), request_key: Type.String({ minLength: 1, maxLength: 200 }),
      values: Type.Optional(Type.Array(Type.Object({ node: Type.String(), input: Type.String(), value: Type.Unknown() }), { maxItems: 500 })),
      files: Type.Optional(Type.Array(Type.Object({ node: Type.String(), input: Type.String(), path: Type.String({ description: "Original absolute input file path. For a pasted image/attachment reference, resolve it with desktop_get_image_path first." }) }), { maxItems: 20 })),
      output_nodes: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 100, description: "Filter collected results to these output-node IDs from inspect. Execution still follows the complete saved graph." })),
    }),
    async execute(_id, params, signal) {
      const result = await submitWorkflow(dataDir, { workflowId: params.workflow_id, revision: params.revision, requestKey: params.request_key,
        values: params.values, files: params.files, outputNodes: params.output_nodes }, compileDesktopWorkflow, signal);
      return { content: [{ type: "text", text: JSON.stringify({ ...workflowJobSummary(result), ...("reused" in result ? { reused: result.reused } : {}) }) }], details: { jobId: result.id }, ...(result.status === "failed" ? { isError: true } : {}) };
    },
  });
}
