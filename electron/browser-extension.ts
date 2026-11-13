import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestGoal } from "./goal-extension.js";
import { browserPolicy, browserCapabilities } from "../shared/browser.js";

export default function browserExtension(pi: ExtensionAPI, request = requestGoal) {
  pi.registerTool({
    name: "browser", label: "Встроенный браузер", description: `${browserPolicy} ${browserCapabilities}`,
    outputSchema: Type.Object({
      tabs: Type.Optional(Type.Array(Type.Unknown())), tab: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      viewport: Type.Optional(Type.Record(Type.String(), Type.Unknown())), page: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      frames: Type.Optional(Type.Array(Type.Unknown())), tools: Type.Optional(Type.Array(Type.Unknown())),
      logs: Type.Optional(Type.Array(Type.Unknown())), downloads: Type.Optional(Type.Array(Type.Unknown())),
      result: Type.Optional(Type.Unknown()), ready: Type.Optional(Type.Boolean()), timedOut: Type.Optional(Type.Boolean()),
      loading: Type.Optional(Type.Boolean()), visible: Type.Optional(Type.Boolean()), closed: Type.Optional(Type.Boolean()),
      cancelled: Type.Optional(Type.Boolean()), untrusted: Type.Optional(Type.Boolean()), note: Type.Optional(Type.String()),
      images: Type.Optional(Type.Array(Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }))),
    }, { additionalProperties: true }),
    promptGuidelines: ["Returns an object directly: result.tabs/tab/page/etc. Screenshot blocks are in result.images; display with image(block), never text() their base64. Do not JSON.parse the result."],
    parameters: Type.Object({
      action: Type.Union(["list", "open", "navigate", "select", "handoff", "state", "snapshot", "screenshot", "logs", "webmcp-list", "webmcp-call", "webmcp-result", "wait", "viewport", "viewport-reset", "click", "move", "drag", "type", "fill", "check", "uncheck", "select-option", "key", "scroll", "back", "forward", "reload", "stop-loading", "zoom", "dialog", "upload", "downloads", "close", "show", "hide"].map(value => Type.Literal(value))),
      tabId: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
      x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()),
      endX: Type.Optional(Type.Number()), endY: Type.Optional(Type.Number()),
      replace: Type.Optional(Type.Boolean({ description: "For type: select all in the focused field before inserting text." })),
      text: Type.Optional(Type.String({ maxLength: 10000 })), key: Type.Optional(Type.String()),
      deltaX: Type.Optional(Type.Number()), deltaY: Type.Optional(Type.Number()),
      button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
      clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      modifiers: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
      waitUntil: Type.Optional(Type.Union(["load", "domcontentloaded", "networkidle"].map(value => Type.Literal(value)))),
      selector: Type.Optional(Type.String({ maxLength: 1000, description: "For wait: wait for a visible element matching this CSS selector." })),
      locator: Type.Optional(Type.Object({
        selector: Type.Optional(Type.String({ maxLength: 1000 })), role: Type.Optional(Type.String({ maxLength: 100 })),
        name: Type.Optional(Type.String({ maxLength: 1000 })), text: Type.Optional(Type.String({ maxLength: 1000 })),
        label: Type.Optional(Type.String({ maxLength: 1000 })), placeholder: Type.Optional(Type.String({ maxLength: 1000 })),
        testId: Type.Optional(Type.String({ maxLength: 1000 })), exact: Type.Optional(Type.Boolean()),
        nth: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
        frames: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 8 })),
      }, { description: "One selector/role/text/label/placeholder/testId; frames is an ordered chain of iframe CSS selectors. Actions use Playwright auto-waiting and strict matching." })),
      elementState: Type.Optional(Type.Union(["attached", "detached", "visible", "hidden"].map(value => Type.Literal(value)))),
      values: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
      fullPage: Type.Optional(Type.Boolean()),
      clip: Type.Optional(Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }), width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }) })),
      filter: Type.Optional(Type.String({ maxLength: 1000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      levels: Type.Optional(Type.Array(Type.Union(["debug", "info", "warning", "error"].map(value => Type.Literal(value))), { maxItems: 4 })),
      toolId: Type.Optional(Type.String()), callId: Type.Optional(Type.String()), arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      waitForText: Type.Optional(Type.String({ maxLength: 1000, description: "For wait: wait for visible page text, not input values." })),
      width: Type.Optional(Type.Integer({ minimum: 200, maximum: 3840 })),
      height: Type.Optional(Type.Integer({ minimum: 200, maximum: 2160 })),
      zoom: Type.Optional(Type.Number({ minimum: 0.25, maximum: 3 })),
      accept: Type.Optional(Type.Boolean()), promptText: Type.Optional(Type.String({ maxLength: 10000 })),
      files: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      let approved = false;
      if (params.action === "webmcp-call") {
        const listed = await request("browser", { action: "webmcp-list", tabId: params.tabId }, signal) as { tab: { url: string }; tools: { id: string; name: string; description: string; origin?: string; frameUrl?: string }[] };
        const tool = listed.tools.find(tool => tool.id === params.toolId);
        if (!tool) throw new Error("Инструмент сайта устарел. Получите webmcp-list заново.");
        approved = await ctx.ui.confirm("Инструмент сайта (недоверенные данные)", `Страница: ${listed.tab.url}\nИсточник инструмента: ${tool.origin || listed.tab.url}\nIframe: ${tool.frameUrl || listed.tab.url}\nИнструмент: ${tool.name}\n${tool.description}\nАргументы: ${JSON.stringify(params.arguments ?? {})}\nРазрешить этот вызов?`);
        if (!approved || signal?.aborted) return { content: [{ type: "text" as const, text: "Вызов инструмента сайта отменён пользователем." }], details: undefined,
          structuredContent: { cancelled: true, note: "Site tool call cancelled by the user." } };
      }
      const result = await request("browser", { ...params, approved, vision: Boolean(ctx.model?.input.includes("image")) }, signal) as { image?: string; [key: string]: unknown };
      const { image, ...metadata } = result;
      const images = image ? [{ type: "image" as const, data: image, mimeType: "image/png" }] : [];
      return { content: [
        { type: "text" as const, text: JSON.stringify(metadata) },
        ...images,
      ], structuredContent: { ...metadata, ...(images.length ? { images } : {}) } as NonNullable<AgentToolResult<undefined>["structuredContent"]>, details: undefined };
    },
  });
}
