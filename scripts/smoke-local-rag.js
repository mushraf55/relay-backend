import express from 'express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { client } from '../src/infrastructure/database.js';
import { aiRouter } from '../src/features/ai/routes.js';
import { aiConfig } from '../src/features/ai/client.js';
if (aiConfig().provider !== 'ollama') throw new Error('This smoke test runs only against local Ollama.');
const id = `test:${randomUUID()}`;
const data = { bots: [{ id:'test-bot',name:'Relay Test',tone:'Concise',instructions:'Answer in one short sentence.',fallback:'I do not know.' }], sources:[{id:'test-source',botId:'test-bot',title:'Support hours',content:'The Relay support desk opens at 9am and closes at 5pm, Monday to Friday. The support extension is 7319.',type:'Text'}] };
const app = express(); app.use(express.json()); app.use((req,_res,next) => {req.workspaceId=id;req.isAdmin=true;next();}); app.use('/ai',aiRouter);
const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
const post=async (path,body) => {const response=await fetch(`http://127.0.0.1:${server.address().port}/ai${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const json=await response.json(); if(!response.ok) throw new Error(json.error);return json;};
try {
  await client`INSERT INTO relay.workspaces(id,data) VALUES(${id},${JSON.stringify(data)}::jsonb)`;
  const trained=await post('/train',{botId:'test-bot',sourceId:'test-source'});
  console.log('Real source indexed:',trained.chunks,'chunks;',trained.dimensions,'dimensions');
  const result=await post('/chat',{botId:'test-bot',message:'What is the support extension?',history:[]});
  assert.ok(result.text.includes('7319'),'Answer must use the source fact');
  assert.ok(result.citations.some(c=>c.sourceId==='test-source'),'Answer must cite the indexed source');
  console.log('Real retrieval and grounded answer with citation: PASS');
} finally {
  await client`DELETE FROM relay.workspaces WHERE id=${id}`;
  await new Promise(r=>server.close(r)); await client.end({timeout:2});
  console.log('Temporary test workspace removed.');
}
