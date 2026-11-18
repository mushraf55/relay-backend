import { env } from '../../config/env.js';

export function aiConfig() {
  const genericReady = env.AI_BASE_URL && env.AI_API_KEY && env.CHAT_MODEL && env.EMBEDDING_MODEL;
  if (!genericReady && env.GROQ_API_KEY && env.GROQ_CHAT_MODEL && env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_EMBEDDING_MODEL) {
    return {
      chatBaseUrl: 'https://api.groq.com/openai/v1',
      chatApiKey: env.GROQ_API_KEY,
      chatModel: env.GROQ_CHAT_MODEL,
      embeddingBaseUrl: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
      embeddingApiKey: env.CLOUDFLARE_API_TOKEN,
      embeddingModel: env.CLOUDFLARE_EMBEDDING_MODEL,
    };
  }
  return {
    chatBaseUrl: String(env.AI_BASE_URL || '').replace(/\/$/, ''),
    chatApiKey: env.AI_API_KEY || '',
    chatModel: env.CHAT_MODEL || '',
    embeddingBaseUrl: String(env.AI_BASE_URL || '').replace(/\/$/, ''),
    embeddingApiKey: env.AI_API_KEY || '',
    embeddingModel: env.EMBEDDING_MODEL || '',
  };
}

async function post(baseUrl, apiKey, path, body, fetcher = fetch) {
  if (!baseUrl || !apiKey) throw new Error('Configure the backend AI provider credentials.');
  let response;
  try {
    response = await fetcher(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error('The configured hosted AI provider is unavailable or timed out.');
  }
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.error?.message || ''; } catch { /* Keep errors credential-free. */ }
    throw new Error(`AI provider request failed (${response.status}). ${String(detail).slice(0, 180)}`.trim());
  }
  return response.json();
}

export async function embed(texts, settings = aiConfig(), fetcher = fetch) {
  if (!settings.embeddingModel) throw new Error('Configure EMBEDDING_MODEL or CLOUDFLARE_EMBEDDING_MODEL on the backend.');
  const result = await post(settings.embeddingBaseUrl, settings.embeddingApiKey, '/embeddings', { model: settings.embeddingModel, input: texts }, fetcher);
  const vectors = result.data?.sort((a, b) => a.index - b.index).map(item => item.embedding);
  if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some(vector => !Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value)))) {
    throw new Error('The AI provider returned invalid embeddings.');
  }
  return { vectors, modelKey: `hosted:${settings.embeddingModel}`, dimensions: vectors[0].length };
}

export async function answer(messages, settings = aiConfig(), fetcher = fetch) {
  if (!settings.chatModel) throw new Error('Configure CHAT_MODEL or GROQ_CHAT_MODEL on the backend.');
  const result = await post(settings.chatBaseUrl, settings.chatApiKey, '/chat/completions', { model: settings.chatModel, messages }, fetcher);
  const text = result.choices?.[0]?.message?.content;
  if (!text?.trim()) throw new Error('The AI provider returned an empty answer.');
  return text.trim();
}

export async function* streamAnswer(messages, settings = aiConfig(), fetcher = fetch) {
  if (!settings.chatModel) throw new Error('Configure CHAT_MODEL or GROQ_CHAT_MODEL on the backend.');
  let response;
  try {
    response = await fetcher(`${settings.chatBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.chatApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.chatModel, messages, stream: true }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error('The configured hosted AI provider is unavailable or timed out.');
  }
  if (!response.ok || !response.body) throw new Error(`AI provider streaming request failed (${response.status}).`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const data = line.trim().replace(/^data:\s*/, '');
      if (!data || data === '[DONE]') continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) yield delta;
    }
    if (done) break;
  }
}

export function chunkText(text, size = 1800, overlap = 180) {
  const cleaned = String(text || '').replace(/\r\n/g, '\n').trim();
  const chunks = [];
  for (let start = 0; start < cleaned.length; start += size - overlap) {
    chunks.push(cleaned.slice(start, start + size));
    if (start + size >= cleaned.length) break;
  }
  return chunks;
}
