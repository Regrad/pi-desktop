import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedPlanRevision, planIsWorking } from '../shared/plan-activity.ts';
import { updatedPlan, isPlanComplete } from '../shared/plan.ts';
import { approvedPlanning, isPlanning } from '../shared/planning.ts';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const plan = { revision: 4, execution: 'active', steps: [{ step: 'Work', status: 'in_progress' }] };
function startHandler() {
  const source = readFileSync(new URL('../electron/pi-manager.ts', import.meta.url), 'utf8');
  const start = source.indexOf('    if (event.type === "agent_start") {', source.indexOf('  private async handleEvent('));
  const end = source.indexOf('      runtime.liveMessage = undefined;', start);
  assert.ok(start > 0 && end > start);
  const body = source.slice(start + '    if (event.type === "agent_start") {'.length, end);
  const invoke = new Function('confirmedPlanRevision', stripTypeScriptTypes(`function startRun(runtime, event, conversationId = 'chat') { ${body}; return event; }`) + '; return startRun;')(confirmedPlanRevision);
  return { source, invoke };
}

test('scheduled checklist runs confirm animation at agent_start, not during context loading', () => {
  const { source, invoke } = startHandler();
  for (const scheduled of [4, undefined, 3]) {
    const runtime = { pendingPlanStartRevision: scheduled, snapshot: {} };
    const event = invoke.call({ store: { getConversation: () => ({ plan }) } }, runtime, { type: 'agent_start' });
    assert.equal(planIsWorking(plan, true, runtime.planWorkingRevision), scheduled === 4);
    assert.equal(event.planWorkingRevision, runtime.snapshot.planWorkingRevision);
    assert.equal(runtime.pendingPlanStartRevision, undefined);
  }
  assert.match(source, /runtime\.pendingPlanStartRevision = expectedPlanRevision/);
  const ui = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(ui, /planWorkingRevision: event\.planWorkingRevision/);
});
test('technical recovery keeps the confirmed checklist across repeated agent starts', () => {
  const { invoke } = startHandler();
  const runtime = { pendingPlanStartRevision: 4, snapshot: {}, activeRun: { startedAt: '2026-10-09T08:48:56Z' } };
  const host = { store: { getConversation: () => ({ plan }) } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const event = invoke.call(host, runtime, { type: 'agent_start' });
    assert.equal(runtime.pendingPlanStartRevision, undefined);
    assert.equal(event.planWorkingRevision, 4);
    assert.equal(runtime.snapshot.planWorkingRevision, 4);
    assert.equal(planIsWorking(plan, true, runtime.planWorkingRevision), true);
  }
});

test('recovery cannot activate an unconfirmed, changed or paused checklist', () => {
  const { invoke } = startHandler();
  for (const [current, confirmation] of [[plan, undefined], [{ ...plan, revision: 5 }, 4],
    [{ ...plan, execution: 'paused' }, 4], [{ ...plan, steps: [] }, 4],
    [{ ...plan, steps: [{ step: 'Work', status: 'completed' }] }, 4], [undefined, undefined]]) {
    const runtime = { planWorkingRevision: confirmation, snapshot: {}, activeRun: { startedAt: '2026-10-09T08:48:56Z' } };
    const event = invoke.call({ store: { getConversation: () => ({ plan: current }) } }, runtime, { type: 'agent_start' });
    assert.equal(event.planWorkingRevision, undefined);
    assert.equal(runtime.snapshot.planWorkingRevision, undefined);
  }
});

test('completed runs and restored processes cannot reuse a previous confirmation', () => {
  const { invoke } = startHandler();
  for (const runtime of [
    { planWorkingRevision: 4, activeRun: { startedAt: 'old', completedAt: 'done' }, snapshot: {} },
    { planWorkingRevision: 4, snapshot: {} },
    { activeRun: { startedAt: 'persisted unfinished run' }, snapshot: {} },
  ]) {
    const event = invoke.call({ store: { getConversation: () => ({ plan }) } }, runtime, { type: 'agent_start' });
    assert.equal(event.planWorkingRevision, undefined);
  }
});

test('settling a run releases confirmation before another request can begin', () => {
  const { source, invoke } = startHandler();
  const anchor = '} else if (event.type === "agent_settled") {';
  const start = source.indexOf(anchor, source.indexOf('  private async handleEvent(')) + anchor.length;
  const end = source.indexOf('      await ', start);
  assert.ok(start >= anchor.length && end > start);
  const settle = new Function('conversationId', 'runtime', source.slice(start, end));
  const runtime = { planWorkingRevision: 4, activeRun: { startedAt: 'same run' }, snapshot: {} };
  // The extracted branch reads the open chat to decide the unread marker.
  settle.call({ store: { snapshot: () => ({ activeConversationId: 'chat' }) } }, 'chat', runtime);
  assert.equal(runtime.planWorkingRevision, undefined);
  const event = invoke.call({ store: { getConversation: () => ({ plan }) } }, runtime, { type: 'agent_start' });
  assert.equal(event.planWorkingRevision, undefined);
});

test('a continuation queued before a step tick still confirms the step it resumes', () => {
  const { invoke } = startHandler();
  const ticked = { ...plan, revision: 5 };
  const runtime = { pendingPlanStartRevision: 4, planContinuationQueued: true, snapshot: {} };
  invoke.call({ store: { getConversation: () => ({ plan: ticked }) } }, runtime, { type: 'agent_start' });
  assert.equal(runtime.planWorkingRevision, 5);
  assert.equal(runtime.planContinuationQueued, undefined);
  assert.equal(planIsWorking(ticked, true, runtime.planWorkingRevision), true);
});

test('an ordinary turn cannot reuse a queued continuation confirmation', () => {
  const { invoke } = startHandler();
  const runtime = { snapshot: {} };
  invoke.call({ store: { getConversation: () => ({ plan }) } }, runtime, { type: 'agent_start' });
  assert.equal(runtime.planWorkingRevision, undefined);
  assert.equal(planIsWorking(plan, true, runtime.planWorkingRevision), false);
});

test('restored current step and context loading do not start animation', () => {
  assert.equal(planIsWorking(plan, true), false);
  assert.equal(confirmedPlanRevision({}, plan, true), undefined);
});
test('model confirmation animates the live run and survives a step tick', () => {
  const revision = confirmedPlanRevision({ execution: 'active' }, plan, true);
  assert.equal(planIsWorking(plan, true, revision), true);
  assert.equal(planIsWorking(plan, false, revision), false);
  // The ticked checklist reaches the renderer apart from its confirmation; a newer revision must
  // not stop the indicator, or it freezes in the middle of real work.
  assert.equal(planIsWorking({ ...plan, revision: 5 }, true, revision), true);
  assert.equal(confirmedPlanRevision({ plan: plan.steps }, plan, true), 4);
  assert.equal(confirmedPlanRevision({ execution: 'active' }, plan, false), undefined);
});
test('cleared and completed plans never animate and a paused plan cannot confirm one', () => {
  assert.equal(confirmedPlanRevision({ execution: 'active' }, { ...plan, execution: 'paused' }, true), undefined);
  for (const changed of [{ ...plan, steps: [] },
    { ...plan, steps: [{ step: 'Work', status: 'completed' }] }]) {
    assert.equal(confirmedPlanRevision({ execution: 'active' }, changed, true), undefined);
    assert.equal(planIsWorking(changed, true, 4), false);
  }
  // Releasing the confirmation (pause, settle) stops the indicator even while output streams.
  assert.equal(planIsWorking({ ...plan, execution: 'paused' }, true, undefined), false);
});

function manualControl() {
  const source = readFileSync(new URL('../electron/pi-manager.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  async controlPlan(');
  const end = source.indexOf('  async removePlan(', start);
  assert.ok(start > 0 && end > start);
  const method = stripTypeScriptTypes('async function controlPlan' + source.slice(start, end).slice('  async controlPlan'.length));
  return new Function('updatedPlan', 'isPlanComplete', 'confirmedPlanRevision', 'isPlanning', 'approvedPlanning', `${method}; return controlPlan;`)(updatedPlan, isPlanComplete, confirmedPlanRevision, isPlanning, approvedPlanning);
}

test('manual resume confirms the current streaming run and pause releases it', async () => {
  const control = manualControl();
  const chat = { plan: { ...plan, execution: 'paused' } };
  const runtime = { snapshot: { state: { isStreaming: true, isCompacting: false } } };
  const events = [], launches = [];
  const host = {
    store: { getConversation: () => chat }, runtimes: new Map([['chat', runtime]]),
    goalLaunching: new Set(), goalContinuationRequested: new Set(),
    async updateConversation(_id, patch) { Object.assign(chat, patch); },
    publish(_channel, payload) { events.push(payload.event); },
    launchGoal(id) { launches.push(id); },
  };
  await control.call(host, 'chat', 'resume');
  assert.equal(chat.plan.execution, 'active');
  assert.equal(runtime.planWorkingRevision, chat.plan.revision);
  assert.equal(runtime.snapshot.planWorkingRevision, chat.plan.revision);
  assert.equal(planIsWorking(chat.plan, true, events.at(-1).revision), true);
  assert.deepEqual(launches, ['chat']);
  await control.call(host, 'chat', 'pause');
  assert.equal(runtime.planWorkingRevision, undefined);
  assert.equal(runtime.snapshot.planWorkingRevision, undefined);
  assert.equal(events.at(-1).revision, undefined);
  assert.equal(planIsWorking(chat.plan, true, runtime.planWorkingRevision), false);
});

test('manual control cannot animate idle, loading, compacting or unstarted steps', async () => {
  const control = manualControl();
  for (const [state, steps] of [
    [{ isStreaming: false }, plan.steps],
    [{ isStreaming: false, isCompacting: true }, plan.steps],
    [{ isStreaming: true, isCompacting: true }, plan.steps],
    [{ isStreaming: true }, [{ step: 'Not started', status: 'pending' }]],
  ]) {
    const chat = { plan: { ...plan, execution: 'paused', steps } };
    const runtime = { snapshot: { state } };
    const host = {
      store: { getConversation: () => chat }, runtimes: new Map([['chat', runtime]]),
      goalLaunching: new Set(), goalContinuationRequested: new Set(),
      async updateConversation(_id, patch) { Object.assign(chat, patch); }, publish() {}, launchGoal() {},
    };
    await control.call(host, 'chat', 'resume');
    assert.equal(chat.plan.execution, 'active');
    assert.equal(runtime.planWorkingRevision, undefined);
    assert.equal(runtime.snapshot.planWorkingRevision, undefined);
  }
});

test('a newer plan revision during manual control cannot receive stale confirmation', async () => {
  const chat = { plan: { ...plan, execution: 'paused' } };
  const runtime = { snapshot: { state: { isStreaming: true } } };
  const events = [];
  const host = {
    store: { getConversation: () => chat }, runtimes: new Map([['chat', runtime]]),
    goalLaunching: new Set(), goalContinuationRequested: new Set(),
    async updateConversation(_id, patch) { chat.plan = updatedPlan({ execution: 'paused' }, patch.plan); },
    publish(_channel, payload) { events.push(payload); }, launchGoal() {},
  };
  await manualControl().call(host, 'chat', 'resume');
  assert.equal(chat.plan.execution, 'paused');
  assert.equal(runtime.planWorkingRevision, undefined);
  assert.equal(events.length, 0);
});
