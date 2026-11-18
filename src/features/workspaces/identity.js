export function resolveWorkspaceIdentity(userId, requestedWorkspaceId) {
  if (!userId) return { ok: false, status: 401, error: 'Sign in to continue' };
  const workspaceId = `user:${userId}`;
  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceId) {
    return { ok: false, status: 409, error: 'Active workspace changed. Reload before saving.' };
  }
  return { ok: true, workspaceId, userId };
}
