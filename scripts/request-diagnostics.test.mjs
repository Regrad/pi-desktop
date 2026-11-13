import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import { applyRequestDiagnosticsCompatibility } from "../resources/pi-rpc-bridge/compatibility.js";
import { patchRequestDiagnostics } from "../resources/pi-rpc-bridge/request-diagnostics-patch.js";
import { analyzeTraces } from "./analyze-request-traces.mjs";

const app = process.env.PI_TEST_APP_ROOT || path.resolve('.');
const agent = path.join(app, 'node_modules/@earendil-works/pi-coding-agent');
await applyRequestDiagnosticsCompatibility(agent);
const ai = path.dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(path.join(agent, 'package.json')).href));
const { stream } = await import(pathToFileURL(path.join(ai, 'dist/api/openai-completions.js')));
const { normalizeContext } = await import(pathToFileURL(path.join(ai, 'dist/utils/transcript.js')));
const model = {id:'mock', provider:'llama-cpp', api:'openai-completions', name:'Mock', input:['text','image'],
  reasoning:true, contextWindow:262144, maxTokens:128, cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const configBefore = process.env.PI_DESKTOP_REQUEST_TRACE_CONFIG;
process.env.PI_DESKTOP_REQUEST_TRACE_CONFIG = 'C:/AI_Temp/absent-request-trace-test.json';
test.after(() => { if (configBefore === undefined) delete process.env.PI_DESKTOP_REQUEST_TRACE_CONFIG; else process.env.PI_DESKTOP_REQUEST_TRACE_CONFIG=configBefore; });
const user = text => ({role:'user',content:[{type:'text',text}],timestamp:1});
async function mock(t, handler) {
  const captured=[];
  const server=http.createServer(async(req,res)=>{
    const bytes=[];for await(const b of req)bytes.push(b);
    captured.push(Buffer.concat(bytes));
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    await handler(req,res,captured.length);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {captured,selected:{...model,baseUrl:`http://127.0.0.1:${server.address().port}/v1`}};
}
const answer = text => `data: ${JSON.stringify({id:'mock-'+text,choices:[{index:0,delta:{reasoning_content:'Проверка '+text,content:text},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`;
function send(selected,messages,options={}) {return stream(selected,normalizeContext({messages}),{apiKey:'private-test-key',signal:AbortSignal.timeout(5000),...options}).result();}

test('request compatibility patch is idempotent and rejects unrecognized providers', async()=>{
  const source=await readFile(path.join(ai,'dist/api/openai-completions.js'),'utf8');
  assert.equal(patchRequestDiagnostics(source),source);
  assert.throws(()=>patchRequestDiagnostics(source.replace('            assertDesktopRequest(params);','')),/incomplete/);
  assert.throws(()=>patchRequestDiagnostics('unexpected provider'),/no longer matches/);
});

test('blank histories, blank human turns and payload-hook damage never reach HTTP', async t=>{
  const {captured,selected}=await mock(t,(_req,res)=>res.end(answer('OK')));
  for(const messages of [[],[user(' \n\t')],[user('\u200b')],[{role:'system',content:'System instructions',timestamp:0}]]) {
    const result=await send(selected,messages);
    assert.equal(result.stopReason,'error',JSON.stringify(messages));assert.match(result.errorMessage,/empty model request blocked/);
  }
  for(const replacement of [{messages:[]},{messages:[{role:'user',content:'   '}]}]) {
    const result=await send(selected,[user('Actual task')],{onPayload:()=>replacement});
    assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/empty model request blocked/);
  }
  assert.equal(captured.length,0);
});

test('image-only input and tool continuation with original task stay valid',async t=>{
  const {captured,selected}=await mock(t,(_req,res)=>res.end(answer('OK')));
  const image={role:'user',timestamp:1,content:[{type:'image',data:'aGVsbG8=',mimeType:'image/png'}]};
  assert.notEqual((await send(selected,[image])).stopReason,'error');
  const assistant={role:'assistant',content:[{type:'toolCall',id:'one',name:'probe',arguments:{}}],api:model.api,provider:model.provider,model:model.id,
    stopReason:'toolUse',timestamp:2,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  assert.notEqual((await send(selected,[user('Actual task'),assistant,{role:'toolResult',toolCallId:'one',toolName:'probe',content:[],isError:false,timestamp:3}])).stopReason,'error');
  assert.equal(captured.length,2);
  assert.equal(JSON.parse(captured[1]).messages.at(-1).role,'tool');
});

test('a fetch wrapper cannot erase history after the payload hook and still send HTTP',async t=>{
  const {captured,selected}=await mock(t,(_req,res)=>res.end(answer('OK')));
  const previous=globalThis.fetch;
  globalThis.fetch=(input,init)=>previous(input,{...init,body:JSON.stringify({...JSON.parse(init.body),messages:[]})});
  t.after(()=>{globalThis.fetch=previous;});
  const output=await send(selected,[user('Actual task')]);
  assert.equal(output.stopReason,'error');assert.match(output.errorMessage,/empty model request blocked/);
  assert.equal(captured.length,0);
});

test('capture is byte-exact through installed timing wrapper and concurrent requests stay isolated',async t=>{
  const directory=await mkdtemp('C:/AI_Temp/pi-wire-test-');
  const previous=process.env.PI_DESKTOP_REQUEST_TRACE_DIR;
  process.env.PI_DESKTOP_REQUEST_TRACE_DIR=directory;
  t.after(()=>{if(previous===undefined)delete process.env.PI_DESKTOP_REQUEST_TRACE_DIR;else process.env.PI_DESKTOP_REQUEST_TRACE_DIR=previous;});
  const timing=(await import('../resources/pi-llama-generation-speed/index.js')).default;
  const hooks=new Map();timing({on:(name,fn)=>hooks.set(name,fn)});
  t.after(()=>hooks.get('session_shutdown')?.());
  const replies=[];
  const {captured,selected}=await mock(t,async(_req,res,n)=>{
    const bytes=Buffer.from(answer('reply-'+n));replies.push(bytes);
    for(let offset=0;offset<bytes.length;offset+=5)res.write(bytes.subarray(offset,offset+5));
    res.end();
  });
  const outputs=await Promise.all([send(selected,[user('Task A')]),send(selected,[user('Task B')])]);
  for(const output of outputs)assert.notEqual(output.stopReason,'error',output.errorMessage);
  const folders=(await readdir(directory)).filter(name=>name.startsWith('request-'));
  assert.equal(folders.length,2);
  const analysis=await analyzeTraces(directory);
  assert.equal(analysis.length,2);
  for(const entry of analysis) {
    assert.equal(entry.thinkingMatches,true);assert.equal(entry.textMatches,true);
    assert.equal(entry.toolCallsMatch,true);assert.equal(entry.requestHashMatches,true);assert.equal(entry.responseHashMatches,true);
    assert.deepEqual(entry.parseErrors,[]);assert.equal(entry.responseIds.length,1);
  }
  for(const folder of folders) {
    const prefix=path.join(directory,folder,'http-01');
    const body=await readFile(path.join(prefix,'request.body.json'));
    assert.ok(captured.some(bytes=>bytes.equals(body)));
    assert.equal(JSON.parse(body).timings_per_token,true);
    const raw=await readFile(path.join(prefix,'response.body.raw'));
    const output=JSON.parse(await readFile(path.join(directory,folder,'sdk-output.json'),'utf8'));
    const n=Number(output.responseId.split('-').at(-1));
    assert.deepEqual(raw,replies[n-1]);
    const metadata=JSON.parse(await readFile(path.join(prefix,'transport.json'),'utf8'));
    assert.equal(metadata.complete,true);assert.equal(metadata.responseBytes,raw.length);
    assert.ok(!(await readFile(path.join(directory,folder,'identity.json'),'utf8')).includes('private-test-key'));
    assert.equal(output.content.find(p=>p.type==='thinking').thinking,'Проверка reply-'+n);
  }
});

test('trace directory errors terminate with an SDK error, not a hung stream',async t=>{
  const directory=await mkdtemp('C:/AI_Temp/pi-wire-error-');
  const file=path.join(directory,'file');await writeFile(file,'not a directory');
  const previous=process.env.PI_DESKTOP_REQUEST_TRACE_DIR;process.env.PI_DESKTOP_REQUEST_TRACE_DIR=file;
  t.after(()=>{if(previous===undefined)delete process.env.PI_DESKTOP_REQUEST_TRACE_DIR;else process.env.PI_DESKTOP_REQUEST_TRACE_DIR=previous;});
  const {captured,selected}=await mock(t,(_req,res)=>res.end(answer('OK')));
  const output=await send(selected,[user('Actual task')]);
  assert.equal(output.stopReason,'error');assert.match(output.errorMessage,/request diagnostics/);assert.equal(captured.length,0);
});

test('expired capture stays off and a live request cap stops additional capture',async t=>{
  const directory=await mkdtemp('C:/AI_Temp/pi-wire-limit-');
  const file=path.join(directory,'config.json'),target=path.join(directory,'captures');
  const previous=process.env.PI_DESKTOP_REQUEST_TRACE_CONFIG;
  process.env.PI_DESKTOP_REQUEST_TRACE_CONFIG=file;
  t.after(()=>{if(previous===undefined)delete process.env.PI_DESKTOP_REQUEST_TRACE_CONFIG;else process.env.PI_DESKTOP_REQUEST_TRACE_CONFIG=previous;});
  const {selected}=await mock(t,(_req,res)=>res.end(answer('OK')));
  await writeFile(file,JSON.stringify({enabled:true,directory:target,expiresAt:'2000-01-01T00:00:00Z'}));
  assert.notEqual((await send(selected,[user('Actual task')])).stopReason,'error');
  await assert.rejects(readdir(target),{code:'ENOENT'});
  await writeFile(file,JSON.stringify({enabled:true,directory:target,expiresAt:'2100-01-01T00:00:00Z',maximumRequests:1}));
  for(let i=0;i<2;i++)assert.notEqual((await send(selected,[user('Actual task')])).stopReason,'error');
  assert.equal((await readdir(target)).filter(name=>name.startsWith('request-')).length,1);
});

test('aborted partial responses close capture and finish the SDK stream',async t=>{
  const directory=await mkdtemp('C:/AI_Temp/pi-wire-abort-');
  const previous=process.env.PI_DESKTOP_REQUEST_TRACE_DIR;process.env.PI_DESKTOP_REQUEST_TRACE_DIR=directory;
  t.after(()=>{if(previous===undefined)delete process.env.PI_DESKTOP_REQUEST_TRACE_DIR;else process.env.PI_DESKTOP_REQUEST_TRACE_DIR=previous;});
  const controller=new AbortController();
  const {selected}=await mock(t,(_req,res)=>{
    res.write('data: {"id":"partial","choices":[{"index":0,"delta":{"reasoning_content":"partial"}}]}\n\n');
    setTimeout(()=>controller.abort(),30);
  });
  const output=await send(selected,[user('Actual task')],{signal:controller.signal});
  assert.equal(output.stopReason,'aborted');
  const folder=(await readdir(directory)).find(name=>name.startsWith('request-'));
  const metadata=JSON.parse(await readFile(path.join(directory,folder,'http-01','transport.json'),'utf8'));
  assert.equal(metadata.complete,false);assert.ok(metadata.responseBytes>0);
});
