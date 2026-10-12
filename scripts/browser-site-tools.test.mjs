import test from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { BrowserSiteTools, webMcpBootstrap } from "../electron/browser-site-tools.ts";

function world() {
  const value = createContext({document:Object.assign(new EventTarget(),{forms:[]}),navigator:{},crypto:{randomUUID},isSecureContext:true,location:{origin:"https://example.com"},AbortController,AbortSignal,Event,EventTarget,MutationObserver:class {observe(){}},setTimeout});
  value.window=value; value.top=value;
  runInContext(`(()=>{const tools=new Map();document.modelContext=Object.assign(new EventTarget(),{
    async registerTool(tool,options={}){if(tools.has(tool.name))throw new Error('Duplicate');tools.set(tool.name,tool);this.dispatchEvent(new Event('toolchange'));options.signal?.addEventListener('abort',()=>{tools.delete(tool.name);this.dispatchEvent(new Event('toolchange'))},{once:true})},
    async getTools(){return [...tools.values()].map(t=>({...t,window,origin:location.origin,inputSchema:JSON.stringify(t.inputSchema||{type:'object'})}))},
    async executeTool(tool,input,options){return JSON.stringify(await tools.get(tool.name).execute(JSON.parse(input),options))}
  })})()`,value);
  runInContext(webMcpBootstrap,value); return value;
}
function fixture() {
  const wc={context:world(),isDestroyed:()=>false,executeJavaScript(script){return Promise.resolve().then(()=>runInContext(script,this.context))}};
  const frame={url:'https://example.com',origin:'https://example.com',detached:false,frameTreeNodeId:1,executeJavaScript:script=>wc.executeJavaScript(script)};
  wc.mainFrame={framesInSubtree:[frame]};
  return {wc,host:new BrowserSiteTools(wc)};
}
const register = "document.modelContext.registerTool({name:'test',description:'Test tool',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},execute:async input=>({value:input.value})})";

test("imperative tools expose schema without execute code, validate input and call the same page", async()=>{
  const f=fixture(); await f.wc.executeJavaScript(register);
  const tools=await f.host.list(); assert.equal(tools[0].name,"test"); assert.equal(tools[0].execute,undefined);
  await assert.rejects(f.host.call(tools[0].id,{value:12},100),/схеме/);
  assert.equal((await f.host.call(tools[0].id,{value:"ok"},100)).result.value,"ok");
});
test("navigation, unregistration and re-registration invalidate previous tool IDs",async()=>{
  const f=fixture();await f.wc.executeJavaScript(register);const id=(await f.host.list())[0].id;
  await f.wc.executeJavaScript("document.modelContext.unregisterTool('test')");await f.wc.executeJavaScript(register);
  await assert.rejects(f.host.call(id,{value:"old"},100),/Stale/);
  f.wc.context=world();await f.wc.executeJavaScript(register);
  await assert.rejects(f.host.call(id,{value:"old page"},100),/Stale/);
  const current=(await f.host.list())[0].id;assert.notEqual(current,id);
});
test("site tool cancellation and timeout abort the provided signal without hanging",async()=>{
  const f=fixture();await f.wc.executeJavaScript("document.modelContext.registerTool({name:'pending',description:'Pending',execute:(_input,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>{document.aborted=true;resolve('aborted')}))})");
  const id=(await f.host.list())[0].id;
  await assert.rejects(f.host.call(id,{},20),/Таймаут/);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.wc.context.document.aborted,true);
  await f.host.list();const pending=f.host.call(id,{},1000);await new Promise(resolve=>setImmediate(resolve));f.host.cancel();await assert.rejects(pending,/отменён/);
});
test("tools need an explicit listing and independent documents get separate adapters",async()=>{
  const f=fixture();await f.wc.executeJavaScript(register);await assert.rejects(f.host.call('guessed',{},100),/Сначала/);
  const iframe=world();await runInContext(register,iframe);assert.ok(iframe.__piBrowserSiteTools);assert.equal((await runInContext('window.__piBrowserSiteTools.list()',iframe)).length,1);
});

test("insecure documents do not receive a WebMCP compatibility API",()=>{
  const context=createContext({isSecureContext:false}); context.window=context; context.top=context;
  runInContext(webMcpBootstrap,context); assert.equal(context.__piBrowserSiteTools,undefined);
});
