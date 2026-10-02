import { env } from '../../config/env.js';

export function aiConfig() {
  const provider = env.AI_PROVIDER || 'ollama';
  if (!['ollama', 'openai', 'groq'].includes(provider)) throw new Error('AI_PROVIDER must be ollama, openai or groq');
  const embeddingProvider = env.EMBEDDING_PROVIDER || (provider === 'groq' ? 'ollama' : provider);
  if (!['ollama', 'openai', 'cloudflare'].includes(embeddingProvider)) throw new Error('EMBEDDING_PROVIDER must be ollama, openai or cloudflare');
  const cloudflareBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID || ''}/ai/v1`;
  return {
    provider,
    base: provider === 'ollama' ? (env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434') : provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1',
    chat: provider === 'ollama' ? (env.OLLAMA_CHAT_MODEL || 'qwen3:8b') : provider === 'groq' ? (env.GROQ_CHAT_MODEL || 'openai/gpt-oss-20b') : env.OPENAI_CHAT_MODEL,
    embeddingProvider,
    embeddingBase: embeddingProvider === 'ollama' ? (env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434') : embeddingProvider === 'cloudflare' ? cloudflareBase : 'https://api.openai.com/v1',
    embedding: embeddingProvider === 'ollama' ? (env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:4b') : embeddingProvider === 'cloudflare' ? (env.CLOUDFLARE_EMBEDDING_MODEL || '@cf/qwen/qwen3-embedding-0.6b') : (env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'),
  };
}
function apiKey(provider) {
  if (provider === 'openai') return env.OPENAI_API_KEY;
  if (provider === 'groq') return env.GROQ_API_KEY;
  if (provider === 'cloudflare') return env.CLOUDFLARE_API_TOKEN;
  return '';
}
function providerName(provider) {
  return provider === 'ollama' ? 'Ollama' : provider === 'groq' ? 'Groq' : provider === 'cloudflare' ? 'Cloudflare Workers AI' : 'OpenAI';
}
function requiredKeyName(provider) {
  if (provider === 'groq') return 'GROQ_API_KEY';
  if (provider === 'cloudflare') return 'CLOUDFLARE_API_TOKEN';
  return 'OPENAI_API_KEY';
}
async function request(path, body, settings, fetcher = fetch) {
  const provider = settings.requestProvider || settings.provider;
  const key = apiKey(provider);
  if (provider === 'cloudflare' && !String(settings.requestBase || settings.base || '').includes('/accounts/')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID on the backend before using Cloudflare Workers AI.');
  if (provider === 'cloudflare' && String(settings.requestBase || settings.base || '').includes('/accounts//')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID on the backend before using Cloudflare Workers AI.');
  if (provider !== 'ollama' && !key) throw new Error(`Set ${requiredKeyName(provider)} on the backend before using ${providerName(provider)}.`);
  let response;
  try {
    response = await fetcher(`${settings.requestBase || settings.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(provider !== 'ollama' ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  } catch { throw new Error(`${providerName(provider)} is unavailable or timed out.${provider === 'ollama' ? ' Start Ollama and check the configured models.' : ''}`); }
  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      detail = parsed?.errors?.[0]?.message || parsed?.error?.message || parsed?.message || text;
    } catch { /* Keep provider errors best-effort and credential-free. */ }
    throw new Error(`${provider} request failed (${response.status}). ${detail ? `${String(detail).slice(0, 180)} ` : ''}Check the model name and server configuration.`);
  }
  return response.json();
}

async function streamingRequest(path, body, settings, fetcher, signal) {
  const key = apiKey(settings.provider);
  if (settings.provider !== 'ollama' && !key) throw new Error(`Set ${requiredKeyName(settings.provider)} on the backend before using ${providerName(settings.provider)}.`);
  let response;
  try {
    const timeout = AbortSignal.timeout(180000);
    response = await fetcher(`${settings.base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.provider !== 'ollama' ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(settings.provider === 'ollama'
      ? 'Ollama is unavailable or timed out. Start Ollama and check the configured models.'
      : `${providerName(settings.provider)} is unavailable or timed out.`);
  }
  if (!response.ok) throw new Error(`${settings.provider} request failed (${response.status}). Check the model name and server configuration.`);
  if (!response.body) throw new Error('The model returned an empty response stream.');
  return response;
}

async function* decodedLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) yield line.trim();
      if (done) break;
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

export async function* streamAnswer(messages, settings = aiConfig(), fetcher = fetch, signal) {
  if (!settings.chat) throw new Error('Set OPENAI_CHAT_MODEL before deploying with OpenAI.');
  const ollamaMaxTokens = Math.min(Math.max(Number(env.OLLAMA_NUM_PREDICT) || 4096, 512), 8192);
  const thinkingEnabled = env.OLLAMA_THINK !== 'false';
  const attempts = settings.provider === 'ollama' && thinkingEnabled ? [true, false] : [false];

  for (const think of attempts) {
    const response = await streamingRequest(
      settings.provider === 'ollama' ? '/api/chat' : '/chat/completions',
      {
        model: settings.chat,
        messages,
        stream: true,
        ...(settings.provider === 'ollama'
          ? { think, options: { num_predict: ollamaMaxTokens, num_ctx: 8192 }, keep_alive: '5m' }
          : { max_completion_tokens: 2048 }),
      },
      settings,
      fetcher,
      signal,
    );

    let producedContent = false;
    for await (const line of decodedLines(response.body)) {
      const payload = settings.provider === 'ollama' ? line : line.replace(/^data:\s*/, '');
      if (payload === '[DONE]') break;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      const delta = settings.provider === 'ollama'
        ? event.message?.content
        : event.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        producedContent = true;
        yield delta;
      }
    }
    if (producedContent) return;
  }

  throw new Error('The model returned no final answer after retrying.');
}
export async function embed(texts, settings = aiConfig(), fetcher = fetch) {
  const embeddingProvider = settings.embeddingProvider || settings.provider;
  const embeddingBase = settings.embeddingBase || settings.base;
  const embeddingSettings = { ...settings, requestProvider: embeddingProvider, requestBase: embeddingBase };
  const result = await request(embeddingProvider === 'ollama' ? '/api/embed' : '/embeddings', { model: settings.embedding, input: texts, ...(embeddingProvider === 'ollama' ? { truncate: false, keep_alive: '5m' } : {}) }, embeddingSettings, fetcher);
  const vectors = embeddingProvider === 'ollama' ? result.embeddings : result.data?.sort((a,b) => a.index-b.index).map(item => item.embedding);
  if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some(v => !Array.isArray(v) || !v.length || v.length > 4096 || v.some(n => !Number.isFinite(n)) || v.every(n => n === 0) || v.length !== vectors[0].length)) throw new Error('Embedding model returned invalid vectors.');
  return { vectors, modelKey: `${embeddingProvider}:${settings.embedding}`, dimensions: vectors[0].length };
}
export function embeddingBatchSize(settings = aiConfig()) {
  const provider = settings.embeddingProvider || settings.provider;
  return provider === 'cloudflare' ? 8 : provider === 'openai' ? 32 : 64;
}
export async function answer(messages, settings = aiConfig(), fetcher = fetch) {
  if (!settings.chat) throw new Error('Set OPENAI_CHAT_MODEL before deploying with OpenAI.');
  const ollamaMaxTokens = Math.min(Math.max(Number(env.OLLAMA_NUM_PREDICT) || 4096, 512), 8192);
  const thinkingEnabled = env.OLLAMA_THINK !== 'false';
  const makeBody = think => ({
    model: settings.chat,
    messages,
    stream: false,
    ...(settings.provider === 'ollama'
      ? { think, options: { num_predict: ollamaMaxTokens, num_ctx: 8192 }, keep_alive: '5m' }
      : { max_completion_tokens: 2048 }),
  });
  let result = await request(
    settings.provider === 'ollama' ? '/api/chat' : '/chat/completions',
    makeBody(thinkingEnabled),
    settings,
    fetcher,
  );
  let text = settings.provider === 'ollama' ? result.message?.content : result.choices?.[0]?.message?.content;
  // Reasoning models can consume the full token budget before producing content.
  // A non-thinking retry preserves a useful answer instead of surfacing an empty response.
  if (settings.provider === 'ollama' && !text?.trim() && thinkingEnabled) {
    result = await request('/api/chat', makeBody(false), settings, fetcher);
    text = result.message?.content;
  }
  if (!text?.trim()) throw new Error('The model returned no final answer after retrying.');
  return text;
}
export const KNOWLEDGE_CHUNK_SIZE = 2400;
export const KNOWLEDGE_CHUNK_OVERLAP = 200;
export function chunkText(text, size = KNOWLEDGE_CHUNK_SIZE, overlap = KNOWLEDGE_CHUNK_OVERLAP) {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  const chunks = [];
  for (let start = 0; start < cleaned.length; start += size - overlap) {
    chunks.push(cleaned.slice(start, start + size));
    if (start + size >= cleaned.length) break;
  }
  return chunks;
}
