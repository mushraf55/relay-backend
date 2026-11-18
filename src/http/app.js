import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { verifyToken } from '@clerk/backend';
import { clerkMiddleware, getAuth } from '@clerk/express';
import { sql } from 'drizzle-orm';
import { clerkAuthorizedParties, origins, env } from '../config/env.js';
import { db } from '../infrastructure/database.js';
import { log, requestContext } from '../infrastructure/observability.js';
import { aiRouter } from '../features/ai/routes.js';
import { coreAnalyticsRouter } from '../features/analytics/core-routes.js';
import { deployRouter } from '../features/deployments/routes.js';
import { knowledgeRouter } from '../features/knowledge/routes.js';
import { embedScript, publicRouter } from '../features/public-chat/simple-routes.js';
import { websiteRouter } from '../features/websites/routes.js';
import { workspaceRouter } from '../features/workspaces/routes.js';
import { resolveWorkspaceIdentity } from '../features/workspaces/identity.js';

export const app = express();

app.disable('x-powered-by');
if (env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use(requestContext);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || origins.includes(origin)) return callback(null, true);
    log('warn', 'cors_rejected', { origin });
    const error = new Error('Origin is not allowed');
    error.status = 403;
    return callback(error);
  },
  methods: ['GET', 'PUT', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Workspace-Id', 'X-Relay-Embed-Origin', 'X-Chat-Session'],
}));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ready', async (_req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});
app.get('/embed.js', embedScript);

app.use('/public', cors({
  origin: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Relay-Embed-Origin', 'X-Chat-Session'],
}), express.json({ limit: '100kb' }), rateLimit({ windowMs: 60_000, limit: 30 }), publicRouter);

app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api', clerkMiddleware({ publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY, authorizedParties: clerkAuthorizedParties }));
app.use('/api', async (req, res, next) => {
  const auth = getAuth(req);
  let userId = auth.userId;
  if (!userId && /^Bearer\s+\S+/.test(req.get('Authorization') || '')) {
    try {
      const claims = await verifyToken((req.get('Authorization') || '').replace(/^Bearer\s+/i, ''), { secretKey: env.CLERK_SECRET_KEY, authorizedParties: clerkAuthorizedParties });
      userId = claims.sub;
    } catch (error) {
      req.clerkFallbackError = error;
      log('warn', 'clerk_token_fallback_failed', { requestId: req.requestId, code: error.code, name: error.name });
    }
  }
  if (!userId) {
    const rawAuth = typeof req.auth === 'function' ? req.auth() : {};
    const detail = env.NODE_ENV === 'production'
      ? {}
      : { authReason: rawAuth.reason || null, authMessage: rawAuth.message || req.clerkFallbackError?.message || null, hasAuthorization: /^Bearer\s+\S+/.test(req.get('Authorization') || '') };
    log('warn', 'auth_required', { requestId: req.requestId, path: req.path, hasAuthorization: /^Bearer\s+\S+/.test(req.get('Authorization') || '') });
    return res.status(401).json({ error: 'Sign in to continue', ...detail });
  }
  const identity = resolveWorkspaceIdentity(userId, req.headers['x-workspace-id']);
  if (!identity.ok) return res.status(identity.status).json({ error: identity.error });
  req.workspaceId = identity.workspaceId;
  req.userId = identity.userId;
  return next();
});
app.use(express.json({ limit: '2mb' }));
app.use('/api', async (req, _res, next) => {
  await db.execute(sql`INSERT INTO relay.workspaces(id) VALUES(${req.workspaceId}) ON CONFLICT DO NOTHING`);
  next();
});

app.use('/api/workspace', workspaceRouter);
app.use('/api/ai', aiRouter);
app.use('/api/analytics', coreAnalyticsRouter);
app.use('/api/knowledge', knowledgeRouter);
app.use('/api/deploy', deployRouter);
app.use('/api/websites', websiteRouter);

app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found' }));
app.use((error, req, res, _next) => {
  void _next;
  const status = error.status || (error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500);
  // Never log request bodies, connection URLs, or SDK response objects.
  log(status >= 500 ? 'error' : 'warn', 'request_failed', { requestId: req.requestId, status, code: error.code, name: error.name });
  const message = status === 500
    ? 'Service unavailable. Please retry.'
    : status === 403
      ? 'Origin is not allowed'
      : status === 413
        ? 'Request body is too large'
        : 'Invalid request body';
  res.status(status).json({ error: message });
});
