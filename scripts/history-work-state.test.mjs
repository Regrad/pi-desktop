import test from 'node:test';
import assert from 'node:assert/strict';
import { historyWorkState } from '../shared/history-work-state.ts';
const plan = { steps: [{step:'Work',status:'in_progress'}], execution:'active', revision:2, updatedAt:'old' };
const tool = value => ({type:'message',message:{role:'toolResult',toolName:'update_plan',content:[{type:'text',text:JSON.stringify(value)}]}});
test('latest confirmed state wins; errors and summaries cannot invent a checklist',()=>{
  assert.equal(historyWorkState([tool({plan}),tool({plan:null})]).plan,undefined);
  assert.equal(historyWorkState([{type:'compaction',summary:JSON.stringify({plan})}]).plan,undefined);
  const error=tool({plan:null});error.message.isError=true;
  assert.equal(historyWorkState([tool({plan}),error]).plan.steps[0].step,'Work');
});
test('legacy service snapshot and full state snapshots restore; clears remain cleared',()=>{
  const legacy={type:'custom_message',customType:'desktop_plan_state',content:`Checklist snapshot (revision 2):\n${JSON.stringify(plan)}\n`,timestamp:'old'};
  assert.equal(historyWorkState([legacy]).plan.execution,'paused');
  const full={type:'custom_message',customType:'desktop_plan_state',details:{workState:plan}};
  assert.equal(historyWorkState([full],{plan:{...plan,revision:8}}).plan.revision,9);
  assert.equal(historyWorkState([full,{...full,details:{workState:null}}]).plan,undefined);
});
test('rewind checkpoints keep removal authoritative on later edits',()=>{
  const reset={type:'custom',customType:'pi_desktop_history_position',data:{workState:{plan:null,goal:null}}};
  assert.equal(historyWorkState([tool({plan}),reset]).plan,undefined);
});
test('delayed service entries cannot revive old state when restoring a retained branch',()=>{
  const newer={...plan,revision:8,execution:'paused',explanation:'user stopped'};
  const delayed={type:'custom_message',customType:'desktop_plan_state',details:{workState:{...plan,revision:7}}};
  const restored=historyWorkState([tool({plan:newer}),delayed]);
  assert.equal(restored.plan.revision,9);
  assert.equal(restored.plan.explanation,'user stopped');
  const goal={id:'g',objective:'Task',steps:1,status:'paused',updatedAt:'2026-10-07T18:19:30Z'};
  const ack=tool({goal});ack.message.toolName='update_goal';
  const stale={type:'custom_message',customType:'desktop_goal_state',details:{workState:{...goal,status:'active',progress:'obsolete',updatedAt:'2026-10-07T18:16:55Z'}}};
  assert.equal(historyWorkState([ack,stale]).goal.progress,undefined);
});
