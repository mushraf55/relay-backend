import { client } from '../../infrastructure/database.js';

export function roleCanEdit(role) {
  return ['Owner', 'Admin', 'Editor'].includes(role);
}

export function appRole(data, email) {
  const member = data?.team?.find(item => String(item.email || '').toLowerCase() === String(email || '').toLowerCase());
  return member?.status === 'Active' ? member.role : null;
}

export async function canEditWorkspace(req) {
  if (req.isAdmin) return true;
  const [row] = await client`SELECT data FROM relay.workspaces WHERE id=${req.workspaceId}`;
  return roleCanEdit(appRole(row?.data, req.userEmail));
}

export async function requireWorkspaceEditor(req, res, next) {
  if (await canEditWorkspace(req)) return next();
  return res.status(403).json({ error: 'Workspace editor access required' });
}
