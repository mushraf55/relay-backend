import { createServer } from 'node:http';
import { app } from './http/app.js';
import { client } from './infrastructure/database.js';
import { env, validateProductionConfig } from './config/env.js';
import { log } from './infrastructure/observability.js';
import { attachSocketServer } from './realtime/socket-server.js';
import { startRecrawlScheduler } from './features/websites/recrawl.js';
import { jobProvider, queueEvent } from './features/knowledge/jobs.js';

validateProductionConfig();
const server = createServer(app);
attachSocketServer(server);
function startQueuedRecrawlScheduler() {
  const minutes = Number(env.RECRAWL_INTERVAL_MINUTES || 60);
  const run = () => {
    void queueEvent({ name: 'relay/websites.recrawl.sweep', data: { limit: Number(env.RECRAWL_BATCH_LIMIT || 20) } })
      .catch(error => log('error', 'scheduled_recrawl_enqueue_failed', { name: error.name, code: error.code }));
  };
  const timer = setInterval(run, Math.max(5, minutes) * 60 * 1000);
  timer.unref?.();
  run();
  return () => clearInterval(timer);
}
const stopRecrawls = jobProvider() === 'inline' ? startRecrawlScheduler() : startQueuedRecrawlScheduler();
const port = Number(env.PORT || 4000);
const host = env.HOST || (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
server.listen(port, host, () => log('info', 'server_ready', { host, port, jobProvider: jobProvider() }));
async function stop() {
  stopRecrawls();
  server.close();
  await client.end({ timeout: 5 });
  log('info', 'server_stopped');
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
