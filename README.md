# Relay backend

The Express backend verifies Clerk sessions, derives a personal workspace from the verified user ID, stores revisioned workspace data, ingests text-based PDFs/text/websites, indexes embeddings in pgvector, retrieves grounded excerpts, generates cited answers, and publishes public chatbots.

Mounted interfaces: `/api/workspace`, `/api/ai`, `/api/knowledge`, `/api/deploy`, `/api/websites`, `/public`, `/embed.js`, `/health`, and `/ready`.

Use the repository root [README](../README.md) for local setup, [DEPLOYMENT.md](../DEPLOYMENT.md) for production, and [LEGACY.md](../LEGACY.md) for unmounted historical experiments.
