import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { connectionUrl, databaseSsl } from '../config/env.js';
export const client = postgres(connectionUrl(), { prepare: false, ssl: databaseSsl, max: 5, connect_timeout: 10, idle_timeout: 20 });
export const db = drizzle(client);
