# Local AI and deployment

For fast hosted chat with your Groq key and cheap hosted Cloudflare Workers AI embeddings, configure `backend/.env`:

```dotenv
AI_PROVIDER=groq
GROQ_API_KEY=your_groq_key
GROQ_CHAT_MODEL=openai/gpt-oss-20b
EMBEDDING_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
CLOUDFLARE_EMBEDDING_MODEL=@cf/qwen/qwen3-embedding-0.6b
```

Groq handles answer generation, while Cloudflare embeds questions and document chunks. Set `EMBEDDING_PROVIDER=ollama` only when you want fully local embeddings during development. If Ollama is not on your PATH, its installed executable is `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`; run it with the `serve` argument.

In Relay, create an assistant → optionally enter a Website URL, or open Knowledge → add Website, Text, FAQ, PDF, DOCX, TXT or Markdown → Add & train → wait for Ready → Playground. Original documents are private in Cloudflare R2. PDF and DOCX text is extracted on the backend. Existing sources need Train/Retrain once after changing embedding providers. Indexing uses overlapping chunks and batched embeddings, which are stored in Supabase, scoped to the authenticated workspace and chatbot. The database stores actual vector dimensions and model identity, rather than padding vectors to 1,536 dimensions.

Chat embeds the question, retrieves up to four current source chunks by cosine distance, and asks the configured chat model to answer using them. Groq and OpenAI use Chat Completions-compatible streaming. Ollama receives a configurable 4,096-token output budget when selected as the chat provider. If a local reasoning model spends that budget without producing final content, Relay retries once with reasoning disabled. Only the final answer is returned, alongside referenced source excerpts. No thinking output is returned to the frontend. Instructions, tone and fallback come from the saved assistant. Playground messages remain temporary and do not populate the conversation inbox.

## OpenAI at deployment

Set server environment variables:

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=your_server_side_key
OPENAI_CHAT_MODEL=your_selected_chat_model
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

Restart the backend and **retrain all sources**. The selected chat model must support Chat Completions and `max_completion_tokens`. No OpenAI calls were made during local testing. The provider adapter never automatically falls back to a paid service. Model-scoped retrieval prevents mixing Ollama and OpenAI embeddings, including when two models have equal dimensions. Retraining replaces a source's old vectors atomically; original source text stays available in the workspace.

## Groq at deployment

Set server environment variables:

```dotenv
AI_PROVIDER=groq
GROQ_API_KEY=your_server_side_key
GROQ_CHAT_MODEL=openai/gpt-oss-20b
EMBEDDING_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
CLOUDFLARE_EMBEDDING_MODEL=@cf/qwen/qwen3-embedding-0.6b
```

Groq is used for chat generation only. Cloudflare Workers AI is used through its OpenAI-compatible embeddings endpoint. Keep `EMBEDDING_PROVIDER=ollama` for free local embeddings, or switch to `EMBEDDING_PROVIDER=openai` with `OPENAI_API_KEY` if you prefer OpenAI embeddings. Retrain all sources whenever the embedding provider or model changes.

## Boundaries

- Supports public HTTPS website scraping for up to 10 same-site HTML pages and 30,000 extracted characters, pasted text and FAQs up to 30,000 characters, plus private PDF, DOCX, TXT and Markdown uploads up to 10 MB. Uploaded text is split into 2,400-character overlapping sections, embedded in batches of up to 64, and each batch is written with one database statement. Client-rendered JavaScript content, robots.txt, OCR, archive formats and malware scanning are not implemented.
- Local Ollama defaults to inline background processing because Inngest Cloud cannot call a localhost model. Deployment should set `JOB_PROVIDER=inngest`; Inngest then retries file extraction, source indexing, cleanup and website recrawls. Provider calls time out after 180 seconds. Reload Knowledge to recover the authoritative status of a Pending or Processing source.
- For local development with Groq or Cloudflare, keep `JOB_PROVIDER=inline` unless you are also running the Inngest dev worker. Otherwise uploads and background jobs can remain queued with no processor.
- Upstash enforces shared per-workspace and public-chat request limits. One in-flight AI request per workspace is also enforced within each backend process. Production still needs enforced monthly token budgets before offering unrestricted paid AI access.
- Retrieval uses exact cosine search with tenant/model filters. Add model-specific vector indexes when source volume requires them.
- Deleted sources/bots have their chunks removed with the workspace update. Changed source text is excluded from retrieval until retrained. Public rooms and widget conversations use the same grounded retrieval service as Playground.
- Answer citations point to model-referenced excerpts; a citation is not a guarantee that the answer is correct.

## Verification

`npm test` runs isolated contract and regression tests. `npm run test:website-scraper` verifies a live public HTML import. `npm run test:ollama` exercises actual embedding, storage, retrieval and an answer with a citation using a synthetic temporary workspace, then removes that workspace. It requires Ollama and database connectivity, and refuses to run with hosted embeddings selected.

Reference: [Ollama embeddings](https://docs.ollama.com/api/embed), [Ollama chat](https://docs.ollama.com/api/chat), [OpenAI embeddings](https://developers.openai.com/api/docs/guides/embeddings), [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
