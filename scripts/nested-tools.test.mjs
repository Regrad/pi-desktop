import test from 'node:test';
import assert from 'node:assert/strict';
import { nestedToolActivities } from '../src/nested-tools.ts';

const tool = (id, parent, running = false) => ({ id, name: 'browser', parentToolCallId: parent, running, startedAt: 1 });
test('finished nested calls stay with their parent and preserve start order', () => {
  const live = { a: tool('p/1', 'p'), b: tool('p/2', 'p', true), c: tool('q/1', 'q') };
  assert.deepEqual(nestedToolActivities('p', live, new Map()).map(t => t.id), ['p/1', 'p/2']);
});
test('reload restores native nestedCalls without inventing tool output', () => {
  const results = new Map([['p', { nestedCalls: { calls: [
    { id: 'p/1', name: 'read', arguments: { path: 'file' }, status: 'ok' },
    { id: 'p/2', name: 'browser', status: 'error', error: 'Failed' },
  ], complete: true } }]]);
  const items = nestedToolActivities('p', {}, results);
  assert.equal(items[0].running, false);
  assert.equal(items[0].result, undefined);
  assert.equal(items[1].error, true);
  assert.equal(items[1].result.content[0].text, 'Failed');
  assert.equal(nestedToolActivities('p', { a: tool('p/1', 'p') }, results).length, 2);
});
test('deeper nesting is placed once and cycles cannot duplicate the parent', () => {
  const live = { a: tool('p/1', 'p'), b: tool('p/1/1', 'p/1'), c: tool('p', 'p/1/1') };
  assert.deepEqual(nestedToolActivities('p', live, new Map()).map(t => t.id), ['p/1', 'p/1/1']);
});
