import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
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

const { imageBudgetBytes, decodedImageBytes, requestImageBytes, pruneRequestImages, imageBudgetRejected, defaultImageBudgetBytes, imageBudgetHysteresis, imageBudgetEnv } =
  await import("../shared/image-budget.ts");
const { default: imageBudgetExtension } = await import("../electron/image-budget-extension.ts");

const megabyte = 1024 * 1024;
/** Build an image block whose decoded size is the requested amount of bytes. */
const image = (bytes) => ({ type: "image", mimeType: "image/png", data: "A".repeat(Math.ceil(bytes * 4 / 3)) });
const text = (value) => ({ type: "text", text: value });
const imagesOf = (message) => message.content.filter(block => block.type === "image").length;
const stubsOf = (message) => message.content.filter(block => block.type === "text" && String(block.text).includes("omitted from this request"));

test("budget comes from the environment and 0 disables trimming", () => {
  assert.equal(imageBudgetBytes({}), defaultImageBudgetBytes);
  assert.equal(imageBudgetBytes({ [imageBudgetEnv]: "" }), defaultImageBudgetBytes);
  assert.equal(imageBudgetBytes({ [imageBudgetEnv]: "2" }), 2 * megabyte);
  assert.equal(imageBudgetBytes({ [imageBudgetEnv]: "0" }), 0);
  for (const broken of ["abc", "-1", "NaN", "Infinity"]) assert.equal(imageBudgetBytes({ [imageBudgetEnv]: broken }), 0, broken);
});

test("only image bytes are counted and the base64 third is discounted", () => {
  assert.equal(decodedImageBytes("A".repeat(4)), 3);
  const messages = [{ role: "user", content: [text("hello"), image(1000)] }];
  assert.equal(requestImageBytes(messages), 1000, "image blocks are counted by decoded bytes, text is free");
  assert.equal(decodedImageBytes("A".repeat(1000)), 750, "base64 overhead is discounted");
  assert.equal(requestImageBytes([{ role: "user", content: "plain" }, null, { role: "assistant" }]), 0);
});

test("a request inside the budget is returned untouched, object by object", () => {
  const first = { role: "user", content: [text("start"), image(megabyte)] };
  const second = { role: "toolResult", toolName: "media_generate_image", content: [text("done"), image(megabyte)] };
  const result = pruneRequestImages([first, second], 4 * megabyte);
  assert.equal(result.removed, 0);
  assert.equal(result.bytesAfter, result.bytesBefore);
  assert.equal(result.messages[0], first, "untouched messages keep identity so the request prefix survives");
  assert.equal(result.messages[1], second);
});

test("a disabled budget never touches the request even when far over", () => {
  const messages = [{ role: "user", content: [image(9 * megabyte)] }];
  const result = pruneRequestImages(messages, 0);
  assert.equal(result.removed, 0);
  assert.equal(imagesOf(result.messages[0]), 1);
});

test("oldest images are replaced, newest images stay, and the session input is not mutated", () => {
  const old = { role: "toolResult", toolName: "media_generate_image", content: [text("Files:\nC:\\out\\old.png"), image(2 * megabyte)] };
  const middle = { role: "toolResult", toolName: "media_generate_image", content: [text("Files:\nC:\\out\\middle.png"), image(2 * megabyte)] };
  const latest = { role: "toolResult", toolName: "browser", content: [text("shot"), image(megabyte)] };
  const input = [old, middle, latest];
  const snapshot = JSON.parse(JSON.stringify(input.map(message => imagesOf(message))));
  const result = pruneRequestImages(input, 3 * megabyte);

  assert.equal(result.bytesBefore, 5 * megabyte);
  assert.ok(result.removed >= 1, "the oldest image must go");
  assert.equal(imagesOf(result.messages[2]), 1, "the newest image stays");
  const firstEviction = pruneRequestImages(input.slice(0, 2), 3 * megabyte);
  assert.ok(firstEviction.bytesAfter <= 3 * megabyte * imageBudgetHysteresis, "crossing the cap frees space for later results");
  assert.ok(result.bytesAfter <= 3 * megabyte, "a new result can use the freed space");
  assert.deepEqual(input.map(message => imagesOf(message)), snapshot, "history keeps every image; only the request is trimmed");
  assert.equal(old.content.length, 2, "the original message object is not rewritten");
});

test("stubs keep the saved path, the producing tool and the message shape", () => {
  const generated = { role: "toolResult", toolName: "media_generate_image", toolCallId: "call-1", content: [text("Image generation completed. Files:\nC:\\out\\render.png\nJob: p-1."), image(3 * megabyte)] };
  const edited = { role: "toolResult", toolName: "media_edit_image", toolCallId: "call-2", content: [text("Files: /tmp/edits/final.jpg"), image(megabyte)] };
  const result = pruneRequestImages([generated, edited, { role: "toolResult", toolName: "browser", toolCallId: "call-3", content: [text("shot"), image(megabyte / 10)] }], megabyte);
  const [trimmed, alsoTrimmed, kept] = result.messages;
  assert.equal(trimmed.role, "toolResult");
  assert.equal(trimmed.toolCallId, "call-1", "tool results must stay bound to their tool call");
  assert.equal(trimmed.toolName, "media_generate_image");
  assert.equal(imagesOf(trimmed), 0);
  assert.match(trimmed.content[0].text, /Image generation completed/, "the original text is preserved");
  const stub = stubsOf(trimmed)[0];
  assert.match(stub.text, /3\.0 MB/, "the model is told how much was dropped");
  assert.match(stub.text, /media_generate_image/);
  assert.match(stub.text, /C:\\out\\render\.png/, "the saved file stays reachable");
  assert.match(stub.text, /read\(path\)/);
  assert.match(stubsOf(alsoTrimmed)[0].text, /\/tmp\/edits\/final\.jpg/, "POSIX paths stay reachable too");
  assert.equal(imagesOf(kept), 1, "the freshest image survives");
  assert.deepEqual(result.messages.map(message => message.toolCallId), ["call-1", "call-2", "call-3"], "message order survives");
});

test("images of the latest user turn are always kept, older user turns are not", () => {
  const firstTurn = { role: "user", content: [text("reference"), image(megabyte)] };
  const work = { role: "toolResult", toolName: "read", toolCallId: "call-r", content: [text("read"), image(megabyte)] };
  const currentTurn = { role: "user", content: [text("fix this one"), image(megabyte)] };
  const result = pruneRequestImages([firstTurn, work, currentTurn], 1.5 * megabyte);
  assert.equal(imagesOf(result.messages[0]), 0, "images of a finished turn are trimmed");
  assert.equal(imagesOf(result.messages[1]), 0);
  assert.equal(imagesOf(result.messages[2]), 1, "what the user just attached has to reach the model");
});

test("saved references preserve spaces and JSON-escaped Windows paths", () => {
  const windows = "C:\\AI\\Pi Desktop\\data\\image one.png";
  const posix = "/tmp/image drafts/image two.jpg";
  const source = [{ role: "toolResult", content: [text(`Files:\n${posix}\n${JSON.stringify({ path: windows })}`), image(3000)] },
    { role: "toolResult", content: [image(2000)] }];
  const stub = stubsOf(pruneRequestImages(source, 4000).messages[0])[0].text;
  assert.ok(stub.includes(windows));
  assert.ok(stub.includes(posix));
});

test("successive tool results preserve the projected prefix until retained images cross the limit again", () => {
  const result = size => ({ role: "toolResult", content: [image(size)] });
  const history = [result(1500), result(1400), result(1200)];
  const first = pruneRequestImages(history, 4000);
  assert.equal(first.removed, 1);
  const next = pruneRequestImages([...history, result(500)], 4000);
  assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages);
  assert.equal(next.removed, 1);

  const huge = [result(200), result(3900)];
  assert.equal(imagesOf(pruneRequestImages(huge, 4000).messages[0]), 0);
  const afterLarge = pruneRequestImages([...huge, result(2500)], 4000);
  assert.equal(imagesOf(afterLarge.messages[0]), 0, "Eviction cannot reintroduce an earlier image");
  assert.equal(imagesOf(afterLarge.messages[2]), 1);
});

test("one oversized image is still sent instead of an imageless request", () => {
  const huge = { role: "user", content: [text("look"), image(9 * megabyte)] };
  const result = pruneRequestImages([huge, { role: "assistant", content: [text("noted")] }], megabyte);
  assert.equal(result.removed, 0);
  assert.equal(imagesOf(result.messages[0]), 1);
});

test("the extension rewrites the request only when it actually trimmed", () => {
  const handlers = new Map();
  imageBudgetExtension({ on: (event, handler) => handlers.set(event, handler) }, { [imageBudgetEnv]: "1" });
  const context = handlers.get("context");
  assert.equal(typeof context, "function");
  const small = [{ role: "user", content: [text("hi"), image(megabyte / 4)] }];
  assert.equal(context({ messages: small }), undefined, "no changes, no rewritten prefix");
  const heavy = [
    { role: "toolResult", toolName: "read", toolCallId: "c-1", content: [text("C:/old.png"), image(megabyte)] },
    { role: "user", content: [text("hi"), image(megabyte / 3)] },
    { role: "toolResult", toolName: "read", toolCallId: "c-2", content: [image(megabyte / 3)] },
  ];
  const rewritten = context({ messages: heavy });
  assert.ok(rewritten?.messages, "an over-budget request is rewritten");
  assert.ok(requestImageBytes(rewritten.messages) < megabyte);
  assert.equal(imagesOf(rewritten.messages[1]), 1, "the current user turn still reaches the model");

  const off = new Map();
  imageBudgetExtension({ on: (event, handler) => off.set(event, handler) }, { [imageBudgetEnv]: "0" });
  assert.equal(off.get("context")({ messages: heavy }), undefined, "PI_DESKTOP_IMAGE_BUDGET_MB=0 turns the feature off");
});

test("the endpoint rejection is recognised without swallowing other 400s", () => {
  assert.equal(imageBudgetRejected('400: {"message":"request image byte budget exceeded","code":"invalid_messages"}'), true);
  assert.equal(imageBudgetRejected("Total image budget 8MB exceeded"), true);
  assert.equal(imageBudgetRejected("tool_use ids were found without tool_result blocks"), false);
  assert.equal(imageBudgetRejected(undefined), false);
});

test("the extension is registered last so it sees the finished message list", () => {
  const process = readFileSync(new URL("../electron/pi-rpc-process.ts", import.meta.url), "utf8");
  const manager = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  assert.match(process, /imageBudgetExtensionPath\?: string;/);
  assert.match(process, /browserExtensionPath,\s*\n\s*\/\/[^\n]*\n\s*this\.options\.imageBudgetExtensionPath,\s*\n\s*\.\.\.\(this\.options\.isolatedExtensions/, "registered after the other Desktop extensions");
  assert.match(manager, /imageBudgetExtensionPath: fileURLToPath\(new URL\("\.\/image-budget-extension\.js", import\.meta\.url\)\)/);
});
