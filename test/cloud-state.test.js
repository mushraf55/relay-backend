import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginCloudWorkspace, mergeCloudWorkspace } from '../../frontend/src/lib/cloud-state.ts';

const initial = { bots: [], sources: [], conversations: [], workspace: 'My workspace', timezone: 'UTC', notifications: {}, profile: { name: 'Owner' } };
const response = { data: {}, revision: 0, billing: { plan: 'Starter', cycle: 'Monthly', bots: 10 }, canEdit: true };

test('onboarding can add a bot when billing contains a numeric bot limit', () => {
  const state = structuredClone(mergeCloudWorkspace(initial, response));
  state.bots.unshift({ id: 'first-bot' });
  state.sources.push({ id: 'first-source', botId: 'first-bot' });
  assert.equal(state.bots[0].id, 'first-bot');
  assert.equal(state.sources.length, 1);
  assert.equal(state.plan, 'Starter');
  assert.deepEqual(initial.bots, []);
});
test('reloading preserves saved bots and ignores server data outside the workspace fields', () => {
  const bots = [{ id: 'saved-bot' }];
  const state = mergeCloudWorkspace(initial, { ...response, data: { bots, signedIn: false, profile: { name: 'Invalid override' } } });
  assert.deepEqual(state.bots, bots);
  assert.deepEqual(state.profile, initial.profile);
  assert.equal(state.signedIn, true);
});
test('malformed saved collections fail without silently discarding saved data', () => {
  assert.throws(() => mergeCloudWorkspace(initial, { ...response, data: { bots: 10 } }), /expected a list/);
});

test('reconnecting to the same workspace keeps visible unsaved state', () => {
  const current = { ...initial, ready: true, bots: [{ id: 'new-bot' }], profile: { name: 'Old owner' } };
  const fresh = { ...initial, ready: false, bots: [{ id: 'sample-bot' }] };
  const result = beginCloudWorkspace(current, fresh, { name: 'Current owner' }, true);
  assert.deepEqual(result.bots, [{ id: 'new-bot' }]);
  assert.equal(result.ready, true);
  assert.equal(result.profile.name, 'Current owner');
});

test('switching workspaces clears the previous workspace collections', () => {
  const current = { ...initial, ready: true, bots: [{ id: 'old-account-bot' }] };
  const fresh = { ...initial, ready: false, bots: [{ id: 'sample-bot' }] };
  const result = beginCloudWorkspace(current, fresh, { name: 'Another owner' }, false);
  assert.deepEqual(result.bots, []);
  assert.equal(result.ready, false);
});
