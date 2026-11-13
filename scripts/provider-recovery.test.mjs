import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchContextRecovery, patchTransportRecovery } from '../resources/pi-rpc-bridge/recovery-patch.js';

const core = path.dirname(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url));
const provider = path.dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(path.join(core,'package.json')).href));
const load = async (file, patch) => {
  const source = readFileSync(path.join(provider, 'dist/utils', file), 'utf8');
  const result = patch(source);
  assert.equal(patch(result), result, 'patch is idempotent');
  return import('data:text/javascript;base64,' + Buffer.from(result).toString('base64'));
};
const {isContextOverflow} = await load('overflow.js', patchContextRecovery);
const {isRetryableAssistantError} = await load('retry.js', patchTransportRecovery);
const error = text => ({role:'assistant', stopReason:'error', errorMessage:text, usage:{input:0,output:0,cacheRead:0}});

test('shared llama.cpp KV exhaustion is overflow even with zero reported usage', () => {
  assert.equal(isContextOverflow(error('Context size has been exceeded.')), true);
  assert.equal(isContextOverflow(error('request (95000 tokens) exceeds the available context size (65536 tokens), try increasing it')), true);
});
test('transport, busy, cache and permanent errors are not context overflow', () => {
  for(const text of ['ECONNRESET','503 no available slots','KV cache evicted','401 unauthorized','429 too many requests'])
    assert.equal(isContextOverflow(error(text)), false, text);
});
test('native retry covers errno and interrupted reasoning streams but never abort or permanent errors', () => {
  for(const text of ['ECONNRESET','ECONNREFUSED','EPIPE','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','Stream ended without finish_reason','503 no available slots']) {
    assert.equal(isRetryableAssistantError(error(text)), true, text);
    assert.equal(isRetryableAssistantError({...error(text),stopReason:'aborted'}), false);
  }
  for(const text of ['401 unauthorized','invalid tool arguments','insufficient_quota','Invalid input batch.'])
    assert.equal(isRetryableAssistantError(error(text)), false, text);
});

const source = readFileSync(path.join(core,'dist/core/agent-session.js'),'utf8');
const anchor='    async _handlePostAgentRun() {';
const start=source.indexOf(anchor)+anchor.length;
const end=source.indexOf('\n    async _runBeforeSettleBoundary()',start);
assert(start>anchor.length && end>start);
const handle = new Function('return async function(){'+source.slice(start,end).replace(/\n    }\s*$/,'')+'}')();
function session(message) {
  const calls=[];
  const results=[{role:'toolResult',toolCallId:'already-ran',content:[{type:'text',text:'Build finished'}]}];
  const host={_lastAssistantMessage:message,_retryAttempt:0,
    agent:{state:{messages:results},hasQueuedMessages:()=>false},
    _isRetryableError:m=>!isContextOverflow(m)&&isRetryableAssistantError(m),
    async _prepareRetry(){calls.push('retry');return true;},
    async _checkCompaction(m){assert.equal(this.agent.state.messages,results);calls.push(isContextOverflow(m)?'compact-and-retry':'no-compaction');return isContextOverflow(m);},
    _finishCancelledRetry(){calls.push('cancel');},_emit(){},
  };
  return {host,calls};
}
test('native post-run routing continues overflow and transient errors without invoking a completed command', async () => {
  for(const [text,expected] of [['Context size has been exceeded.','compact-and-retry'],['ECONNRESET','retry']]) {
    const {host,calls}=session(error(text));
    assert.equal(await handle.call(host),true);
    assert.deepEqual(calls,[expected]);
    assert.equal(host.agent.state.messages[0].toolCallId,'already-ran');
  }
});
test('Stop has priority over recovery, including Stop during backoff', async () => {
  const {host,calls}=session(error('ECONNRESET'));
  host._agentRunAbortRequested=true;
  assert.equal(await handle.call(host),false);
  assert.deepEqual(calls,['cancel']);
  host._agentRunAbortRequested=false;
  host._lastAssistantMessage=error('ECONNRESET');
  host._prepareRetry=async()=>{host._agentRunAbortRequested=true;return true;};
  assert.equal(await handle.call(host),false);
});
test('extension errors do not impersonate settled runs in the renderer', () => {
  const ui=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
  const block=ui.slice(ui.indexOf('} else if (event.type === "extension_error")'),ui.indexOf('} else if (event.type === "runtime_error")'));
  assert.match(block,/addNotice/);
  assert.doesNotMatch(block,/setWorking\(false\)/);
});
