import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const configured = levels[env.LOG_LEVEL || 'info'] ?? levels.info;

export function log(level, message, fields = {}) {
  if ((levels[level] ?? levels.info) > configured) return;
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|secret|key|authorization|password|cookie/i.test(key)) continue;
    safe[['level', 'message', 'time'].includes(key) ? `field_${key}` : key] = value;
  }
  console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](JSON.stringify({ level, message, time: new Date().toISOString(), ...safe }));
}

export function requestContext(req, res, next) {
  req.requestId = req.get('X-Request-Id') || randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  const started = process.hrtime.bigint();
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'http_request', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    });
  });
  next();
}
