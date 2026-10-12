import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { desktopMcpDescription, configInfo, diagnosticError, safeEndpoint, validateConfigFiles, withConfigInfo } from "../resources/pi-mcp/desktop-config.js";
import { patchMcpIndex, patchMcpProxy } from "./mcp-config-patch.mjs";

test("v5 patches are pinned, idempotent and leave native codemode/approval machinery intact",()=>{
  for(const [name,patch] of [["index.ts",patchMcpIndex],["proxy-modes.ts",patchMcpProxy]]){
    const source=readFileSync(new URL(`../node_modules/pi-mcp-adapter/${name}`,import.meta.url),'utf8');
    assert.equal(patch(source),source);
    assert.throws(()=>patch('unknown'),/Unsupported/);
    if(name==='index.ts'){
      assert.match(source,/params.action === "config"/);
      assert.match(source,/await startInitialization\(_ctx, owner, generation/);
      assert.match(source,/validateConfigFiles\(configPaths\)/);
      assert.equal((source.match(/name: "mcp"/g)??[]).length,1);
      assert.match(source,/const description = desktopMcpDescription/);
    }else assert.match(source,/diagnosticError\(error, definition\)/);
  }
  assert.match(desktopMcpDescription,/Use codemode/);
  assert.doesNotMatch(desktopMcpDescription,/use mcpScript/i);
});

test("safe configuration metadata excludes credentials and command arguments",()=>{
  const paths=[{path:'C:/portable/data/agent/mcp-adapter.json',exists:true}];
  const info=configInfo({mcpServers:{test:{url:'http://u:secret@localhost/mcp?token=private',bearerToken:'private',args:['secret']}}},paths,paths[0].path);
  assert.equal(info.servers.test.url,'http://localhost/mcp');
  assert.doesNotMatch(JSON.stringify(info),/secret|private/);
  assert.equal(safeEndpoint('bad'),'[invalid URL]');
  assert.equal(configInfo({mcpServers:{}},paths,paths[0].path,undefined,true).globalConfigPath,null);
});

test("invalid JSON fails before replacing a connection and does not reveal its contents",()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'pi-mcp-config-'));
  const file=path.join(folder,'mcp-adapter.json'),paths=[{path:file,exists:true}];
  writeFileSync(file,'{"secret":"dont-display",BROKEN}');
  assert.throws(()=>validateConfigFiles(paths),error=>error.message.includes(file)&&!error.message.includes('dont-display'));
  writeFileSync(file,'\uFEFF{/*comment*/"mcpServers":{},}');
  validateConfigFiles(paths);
});

test("diagnostics expose nested failure causes, not secret credentials",()=>{
  const error=new Error('fetch failed',{cause:Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'),{code:'ECONNREFUSED'})});
  assert.match(diagnosticError(error),/ECONNREFUSED.*8000/);
  assert.doesNotMatch(diagnosticError(new Error('Bearer xyz http://u:p@localhost/mcp?token=abc abc'),{bearerToken:'abc'}),/xyz|token=abc|u:p|\babc\b/);
});

test("actual v5 gateway restarts through native initialization only after a valid changed config",async()=>{
  const source=readFileSync(new URL('../node_modules/pi-mcp-adapter/index.ts',import.meta.url),'utf8');
  const start=source.indexOf('        let executeOwner = currentOwner;',source.indexOf('  function registerProxyTool('));
  const end=source.indexOf('\n      },\n    }));\n    proxyToolRegistered',start);
  assert.ok(start>=0&&end>start);
  const compiled=stripTypeScriptTypes(`async function execute(params:any,signal:any,_ctx:any){${source.slice(start,end)}}`,{mode:'transform'});
  const old={config:{mcpServers:{target:{command:'old'}}}};
  let fresh={mcpServers:{target:{command:'new'}}};
  const calls=[];
  const paths=[{path:'C:/portable/data/agent/mcp-adapter.json',exists:true}];
  const env={state:old,earlyConfig:old.config,earlyConfigPath:undefined,programmaticConfig:false,
    currentOwner:{throwIfInactive(){},async stop(){calls.push('stop');}},currentOAuthRuntime:null,
    lifecycleGeneration:0,initPromise:null,initStartedPromise:null,retainedInitFailure:null,
    getConfigDiscoveryPaths:()=>paths,getPiGlobalConfigPath:()=>paths[0].path,
    validateConfigFiles(){},loadMcpConfig:()=>fresh,configInfo,withConfigInfo,diagnosticError,
    captureRuntimeGuard:()=>({}),loadProxyModes:()=>({}),async loadForRuntime(loader){return loader();},
    clearRetainedInitFailure(){},createMcpRuntimeOwner:()=>({throwIfInactive(){}}),
    async shutdownState(){calls.push('shutdown');},
    async startInitialization(){calls.push('native-trust-init');env.state={config:fresh};env.initPromise=Promise.resolve(env.state);},
    async connectAndReport(state){calls.push(state.config.mcpServers.target.command);return {content:[],details:{mode:'connect'}};},
  };
  const execute=new Function('env',`with(env){${compiled};return execute;}`)(env);
  const result=await execute({connect:'target'},new AbortController().signal,{cwd:'project'});
  assert.deepEqual(calls,['stop','shutdown','native-trust-init','new']);
  assert.equal(result.details.desktopConfig.globalConfigPath,paths[0].path);
  calls.length=0;
  await execute({connect:'target'},undefined,{cwd:'project'});
  assert.deepEqual(calls,['new']);
  fresh={mcpServers:{target:{command:'bad',url:'http://localhost/mcp'}}};
  calls.length=0;
  const badTransport=await execute({connect:'target'},undefined,{cwd:'project'});
  assert.equal(badTransport.details.error,'config_reload_failed');
  assert.deepEqual(calls,[]);
  env.validateConfigFiles=()=>{throw new Error('invalid config');};
  calls.length=0;
  const failed=await execute({connect:'target'},undefined,{cwd:'project'});
  assert.equal(failed.details.error,'config_reload_failed');
  assert.deepEqual(calls,[]);
});
