import { createServer } from 'node:http';
import { app } from './http/app.js';
import { client } from './infrastructure/database.js';
import { env, validateProductionConfig } from './config/env.js';
import { log } from './infrastructure/observability.js';

validateProductionConfig();
const server = createServer(app);
const port = Number(env.PORT || 4000);
const host = env.HOST || (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
server.listen(port, host, () => log('info', 'server_ready', { host, port }));
async function stop() {
  server.close();
  await client.end({ timeout: 5 });
  log('info', 'server_stopped');
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
