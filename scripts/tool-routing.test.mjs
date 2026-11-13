import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import routing, { routeTool, declaredTools } from "../resources/tool-routing/index.js";
import { patchToolRouting } from "./tool-routing-patch.mjs";
import { patchCodemodeDiscoveryDescription } from "../resources/tool-routing/patch.js";
import { collectAnswerMedia } from "../src/comfy-images.ts";

test("codemode discovery description documents async helpers and array metadata", async () => {
  const source = await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js", import.meta.url), "utf8");
  const patched = patchCodemodeDiscoveryDescription(source);
  assert.equal(patchCodemodeDiscoveryDescription(patched), patched);
  assert.match(patched, /ALL_TOOLS\.map\(t => t\.name\)/);
  for (const helper of ["searchTools", "describeTool", "describeNamespace"]) assert.ok(patched.includes(`text(await ${helper}`));
  assert.throws(() => patchCodemodeDiscoveryDescription("unknown"), /anchor changed/);
  assert.equal(patchCodemodeDiscoveryDescription(source.replace(/\r?\n/g, "\r\n")), patched.replace(/\r?\n/g, "\r\n"));
});

test("generic exposure policy preserves native restrictions and execution arguments", async t => {
  const previous = process.env.PI_DESKTOP_TOOL_ROUTING;
  process.env.PI_DESKTOP_TOOL_ROUTING = "1";
  t.after(() => previous === undefined ? delete process.env.PI_DESKTOP_TOOL_ROUTING : process.env.PI_DESKTOP_TOOL_ROUTING = previous);
  const signal = new AbortController().signal, ctx = {}, update = () => {};
  const result = {content:[{type:"image",data:"fixture",mimeType:"image/png"}],details:{media:[]}};
  const original = {name:"new_addon",parameters:{type:"object"},execute(...args){assert.deepEqual(args,["id",{},signal,update,ctx]);return result;}};
  const deferred = routeTool(original,"custom/addon");
  assert.equal(deferred.exposure,"deferred");
  assert.equal(routeTool(deferred),deferred);
  const actual = await deferred.execute("id",{},signal,update,ctx);
  assert.deepEqual(actual.content, result.content);
  assert.deepEqual(actual.structuredContent,{data:null,text:"",images:result.content,details:result.details});
  for (const name of ["read","bash","update_plan","update_notebook","get_goal"]) {const tool={...original,name};assert.equal(routeTool(tool),tool);}
  for (const exposure of ["hidden","model-only"]) {const tool={...original,exposure};assert.equal(routeTool(tool),tool);}
  const structured={...original,outputSchema:{type:"object"}};
  assert.equal(routeTool(structured).execute,structured.execute);
  assert.equal(routeTool({...original,name:"mcpScript"}).exposure,"hidden");
  assert.deepEqual(declaredTools(["read","new_addon","codemode"],[deferred,{name:"codemode",exposure:"model-only"}]),["read","codemode"]);
  await assert.rejects(routeTool({...original,execute(){throw new Error("original failure");}}).execute(),/original failure/);
});

test("untyped add-ons expose complete JSON as data without guessing prose, fragments or multiple blocks", async t => {
  const previous = process.env.PI_DESKTOP_TOOL_ROUTING;
  process.env.PI_DESKTOP_TOOL_ROUTING = "1";
  t.after(() => previous === undefined ? delete process.env.PI_DESKTOP_TOOL_ROUTING : process.env.PI_DESKTOP_TOOL_ROUTING = previous);
  const run = async result => (await routeTool({name:"untyped_addon",execute:async()=>result}).execute()).structuredContent;
  for (const value of [{items:[{name:"node"}],nextOffset:20}, [1,2], {}]) {
    const result=await run({content:[{type:"text",text:JSON.stringify(value)}],details:{}});
    assert.deepEqual(result.data,value);
  }
  for (const text of ['[invalid JSON', 'Result: {"items":[]}', '```json\n{"items":[]}\n```', 'null', '42']) {
    const result=await run({content:[{type:"text",text}],isError:true});
    assert.equal(result.data,null); assert.equal(result.text,text); assert.equal(result.isError,true);
  }
  const blocks=[{type:"text",text:'{"items":[]}'},{type:"text",text:"A separate warning"}];
  const result=await run({content:blocks}); assert.equal(result.data,null); assert.match(result.text,/separate warning/);
  assert.deepEqual((await run({content:[],structuredContent:{native:true}})).data,{native:true});
});

test("loader patch is idempotent and refuses unknown loader source",async () => {
  const source=await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",import.meta.url),"utf8");
  const patched=patchToolRouting(source);
  assert.equal(patchToolRouting(patched),patched);
  const original=source.replace(/^import .*desktop-tool-routing.js.*\r?\n/,"").replace(/\r?\n            tool = routeTool\(tool, extension.path\);/,"").replace("runtime.setActiveTools(routingEnabled() ? declaredTools(toolNames, runtime.getAllTools()) : toolNames);","runtime.setActiveTools(toolNames);");
  assert.equal(patchToolRouting(original),patched);
  assert.throws(()=>patchToolRouting("unknown"),/anchors changed/);
});

test("native parent stores nested media once and retains explicit empty music selection", () => {
  const handlers=new Map();
  routing({on:(name,handler)=>handlers.set(name,handler)});
  const hook=handlers.get("tool_result");
  const audio={type:"audio",path:"C:/song.flac",mimeType:"audio/flac"};
  hook({parentToolCallId:"parent",toolCallId:"nested",toolName:"media_publish_music",input:{},content:[],details:{media:[audio],audioSelection:true},isError:false});
  const result=hook({toolCallId:"parent",details:{native:true}});
  assert.equal(result.details.native,true);
  const parent={id:"parent",name:"codemode",result:{content:[],details:result.details}};
  const child=result.details.desktopNestedMedia[0];
  assert.deepEqual(collectAnswerMedia([parent,child],true,"song.flac").parts,[audio]);
  assert.deepEqual(collectAnswerMedia([parent],true,"song.flac").parts,[audio]);
  assert.equal(parent.result.details.desktopNestedMedia.length,1);
  hook({parentToolCallId:"empty",toolCallId:"none",toolName:"media_publish_music",input:{},content:[],details:{media:[],audioSelection:true},isError:false});
  const empty={id:"empty",name:"codemode",result:hook({toolCallId:"empty",details:{}})};
  assert.deepEqual(collectAnswerMedia([parent,empty]).parts,[]);
});
