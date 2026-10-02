# Relay Express backend

Requires Node 22+ and the Clerk and Supabase credentials already supplied in the root `.env.local`.

```powershell
cd backend
npm install
npm run env:import
npm run db:migrate
npm run dev
```

Run the Next frontend separately with `npm run dev` from the repository root. The backend listens on localhost:4000; set `NEXT_PUBLIC_API_URL` on the frontend and `APP_URL` on the backend when deploying. The server binds to localhost by default. Database TLS verifies the server certificate; if necessary provide Supabase's certificate with Node's `NODE_EXTRA_CA_CERTS` environment variable.

`env:import` copies credentials into ignored `backend/.env`, preserves existing backend overrides, and percent-encodes database passwords without double encoding. Never print or commit either environment file. Root Clerk keys remain necessary for Next.js authentication. Supabase public keys are not needed: Express accesses Supabase Postgres through Drizzle/Postgres.js with prepared statements disabled for transaction pooling.

## Authentication and storage

Clerk handles registration, verification, password recovery, sessions, organizations and team invitations. Next's proxy protects dashboard/onboarding; Express independently verifies the session token, including allowed frontend origins. Workspace IDs come exclusively from verified Clerk claims. Personal accounts own their workspace; organization admins can write and manage billing, other organization members have read access.

`GET /api/workspace` loads data and revision. `PUT /api/workspace` accepts a revision and validated data; stale writes return 409. Workspace application data initially lives in a versioned JSONB document. Billing fields are separate server-owned columns and cannot be changed through that document. Plan chatbot limits are enforced server-side. Data is stored in a private `relay` schema with RLS enabled and no public Supabase API grants. The privileged server database role is responsible for tenant-scoped queries. The ai_chunks table stores model-scoped vectors for real retrieval; document_chunks is retained from the initial schema.

## Stripe setup

Set six recurring Price IDs and `STRIPE_SECRET_KEY` in `backend/.env`: Starter ($5/mo), Growth ($19/mo), and Scale ($79/mo), each with monthly and yearly prices. Enable Stripe's customer portal in its dashboard. For local webhooks:

```powershell
stripe listen --forward-to localhost:4000/webhooks/stripe
```

Put the printed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`, then restart the backend. Configure the deployed endpoint for `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Test and live webhook secrets differ. Checkout is deliberately unavailable without this secret.

`POST /api/billing/checkout` takes `{ "plan": "Starter", "cycle": "Monthly" }`, `{ "plan": "Growth", "cycle": "Monthly" }`, or `{ "plan": "Scale", "cycle": "Monthly" }`. Existing subscriptions must use `POST /api/billing/portal`. `GET /api/billing` reports access. Only verified webhook processing updates subscription access; returning from Checkout does not grant a plan. Events are deduplicated transactionally and current Stripe subscription state is retrieved to handle delayed delivery. Failed/past-due subscriptions revert to Trial access until payment is restored. No real charge is made by setup scripts.

## Remaining boundaries

Ollama embeddings and grounded chat are connected; see AI.md. The website scraper imports up to 10 public same-site HTML pages. PDF/DOCX/TXT/Markdown uploads use private R2 storage, backend extraction and model-scoped embeddings. Published assistants have persistent shared rooms, mention-gated `@relay` answers, and isolated website-widget rooms. Shopify, WooCommerce and WordPress support read-only snapshot imports; see CONNECTORS.md. JavaScript-only page rendering, OCR, archive formats and malware scanning are not implemented. Workspace JSONB is limited to 2 MB per request, 100 bots, 500 sources and 1,000 conversations; normalize these entities and add pagination before larger workloads. Clerk memberships are read from verified session claims rather than mirrored using Clerk webhooks. Configure short session-token lifetimes to bound membership-change propagation. Production deployment needs a dedicated least-privilege database role and HTTPS. An invoice failure changes Stripe's subscription state, which is reflected by subscription.updated.

`npm test` checks URL encoding. Use the frontend lint/build checks at the repository root. Live sign-in/payment flows require interacting with your configured Clerk and Stripe accounts.

## R2, Inngest and Redis

Uploaded PDF, DOCX, TXT and Markdown files are validated, stored privately in R2, extracted on the backend, embedded, and indexed in Supabase. Upstash Redis provides shared workspace limits for AI and uploads. `npm run services:check` checks access without displaying credentials; `npm run services:test` performs and removes a temporary R2 object and Redis key.

Local Ollama uses `JOB_PROVIDER=inline` because a cloud worker cannot reach `127.0.0.1`. For deployment, configure OpenAI, set `JOB_PROVIDER=inngest`, expose `/api/inngest` over HTTPS, and sync that endpoint in the matching Inngest environment. Event and signing keys must come from that same environment. Inngest retries file indexing, text/website source indexing, object cleanup, and scheduled website recrawls. The backend enqueues a recrawl sweep every `RECRAWL_INTERVAL_MINUTES`; each sweep queues up to `RECRAWL_BATCH_LIMIT` due website sources. Never expose queue keys to the frontend.

## Public chat and widget

Publishing an assistant creates an opaque, persistent share ID and one group room. Human messages are stored in `relay.chat_messages`; only messages containing `@relay` invoke AI. `GET /embed.js` mounts an isolated iframe widget, and each browser tab receives its own widget room. Configure allowed hostnames on the assistant before copying the generated script. Public traffic uses shared Upstash limits.

The Supabase tables live in the private `relay` schema. Select `relay` instead of `public` in Table Editor to inspect them. RLS is enabled and direct `anon`/`authenticated` grants are revoked because Express enforces workspace and public-token boundaries.

## Current local connection setup

The configured direct hostname did not resolve during setup. The transaction-pooler hostname resolved, and its session endpoint on port 5432 responded, but TLS returned `SELF_SIGNED_CERT_IN_CHAIN`. The migrations have since been applied successfully using the session pooler and the supplied CA certificate.

Download the project's database CA certificate from Supabase Database Settings, save it as `backend/supabase-ca.crt`, and set `DATABASE_SSL_CA_PATH=supabase-ca.crt` in `backend/.env`. Then run `npm run db:migrate -- --session-pooler`. This retains certificate verification. The default migration command still uses your supplied `DIRECT_DATABASE_URL`; correct that value in the environment if you prefer the direct endpoint.

Set `STRIPE_WEBHOOK_SECRET` for your active Stripe sandbox. Add it using the local Stripe CLI instructions above. Authentication and payment completion have not been exercised with a real user/payment; local tests cover unauthorized requests and webhook signature rejection, and the browser confirms that a signed-out dashboard visit requires Clerk sign-in.

