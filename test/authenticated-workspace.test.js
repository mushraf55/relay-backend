import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspaceIdentity } from '../src/features/workspaces/identity.js';

test('an authenticated user can access only the workspace derived from their verified identity', () => {
  assert.deepEqual(resolveWorkspaceIdentity('user_123'), {
    ok: true,
    workspaceId: 'user:user_123',
    userId: 'user_123',
  });
  assert.deepEqual(resolveWorkspaceIdentity('user_123', 'user:another_user'), {
    ok: false,
    status: 409,
    error: 'Active workspace changed. Reload before saving.',
  });
  assert.equal(resolveWorkspaceIdentity(null).status, 401);
});
