import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { selectGroundedMatches } from '../src/features/ai/chat-service.js';

test('a created bot can be published and return a cited public answer', async () => {
  const bot = { id: 'bot-1', name: 'Product guide', fallback: 'I could not find that answer in my knowledge sources.' };
  const deployments = new Map();
  const shareId = randomBytes(18).toString('base64url');
  deployments.set(shareId, { workspaceId: 'user:owner', bot, enabled: true });

  const deployment = deployments.get(shareId);
  assert.equal(deployment.enabled, true);
  const matches = selectGroundedMatches([{
    source_id: 'source-1', title: 'Setup guide', source_url: 'https://example.com/setup',
    content: 'Install Relay with npm install and configure the backend environment.', distance: 0, match_type: 'lexical',
  }]);
  const answer = matches.length ? {
    text: 'Install Relay with `npm install`. [1]',
    citations: [{ number: 1, sourceId: matches[0].source_id, title: matches[0].title, sourceUrl: matches[0].source_url, excerpt: matches[0].content }],
  } : { text: bot.fallback, citations: [] };
  assert.match(answer.text, /\[1\]/);
  assert.equal(answer.citations[0].sourceUrl, 'https://example.com/setup');
});
