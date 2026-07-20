# RAG Stack Evaluation (vector store + embedding model)

**Parent doc:** [`rag-per-company-kb-design-doc.md`](./rag-per-company-kb-design-doc.md) (section 3, industry-standard stack)

Section 3 of the design doc names the chosen stack in one table: **Supabase pgvector** for the vector store, **OpenAI `text-embedding-3-small`** for the embeddings. This file holds the full comparison behind those two choices, so the main doc can stay about *what we build* instead of *what we ruled out*. Section numbers below refer to the parent design doc.

## 1. Vector store: why pgvector, and not Chroma / Elasticsearch / Pinecone

Landscape as of July 2026. The store choice is an infrastructure decision, not a retrieval-quality one: the same `text-embedding-3-small` vectors return the same cosine results in any of these stores, so the decision is only about *where the vectors live and how they are queried*. Two project-specific criteria settle it.

1. **The vectors must sit in the same query engine as the tenant data.** The isolation boundary is the SQL filter `where company_key = ...` (section 4). That filter and the vector search have to run in one query, or the tenant boundary moves up into application code that joins two systems. pgvector keeps both in Postgres:

   ```sql
   where company_key = :company and kind = 'detail'   -- tenant boundary
   order by embedding <=> :query_embedding limit 3;    -- vector search
   ```

2. **No new datastore, vendor, key, or ops surface.** RAG already adds moving parts (an embeddings API, an ingest job, retrieval failure modes; section 2). pgvector adds zero *additional* data systems to that list, because this project already runs the Supabase Postgres for every other table; enabling it is one `create extension vector`. Every alternative below adds a whole datastore.

| Store | What it is | Strength | Why not here (yet) |
|---|---|---|---|
| **Supabase pgvector (chosen)** | a `vector` column type + the `<=>` operator inside Postgres | vectors colocated with the tenant data (one query, one key, one auth model); HNSW scales comfortably to millions of vectors on a single Postgres | n/a |
| Chroma | embedded / single-node vector DB, aimed at local prototyping | `pip install` and go; fast local iteration | a separate datastore, so tenant isolation and KB metadata get stitched across two systems; needs a resident service or a local persisted dir, neither of which fits a stateless CI / GitHub Action ingest |
| Elasticsearch / OpenSearch | cluster search engine with `dense_vector` kNN (8.x+) | large-scale full-text and hybrid (BM25 + vector) search | a JVM cluster to run and tune, heavy overkill for ~100 chunks; its edge is keyword / hybrid search, which section 6 deliberately does not use |
| Pinecone / Qdrant / Weaviate | purpose-built managed vector DBs | billions of vectors, high QPS, advanced filtering | a new vendor, key, and bill, with data leaving Postgres; at 2 companies and ~100 chunks none of those advantages apply |

**When we would revisit.** pgvector is not a stopgap: on one Postgres it has a long runway (millions of vectors with HNSW). The signals that would force a move are tens of millions of vectors, very high concurrent QPS, or a real need for large-scale hybrid search. None are on the horizon, and because the ingest and retrieval code is small and the embeddings are portable, a later migration stays contained.

## 2. Embeddings model: which API (Titan V2, paid alternatives, free options)

Prices as of July 2026. At our corpus size the model choice is not a quality or cost decision: the whole KB is ~4,400 tokens today, so a full re-embed of everything costs well under a cent on any provider, and a query is 10-30 tokens. The criteria that actually separate the candidates are (1) fit with what is already deployed and (2) integration surface. Two facts anchor the comparison:

1. **The schema and the ingest job are already live on `text-embedding-3-small`.** The deployed table stores `vector(1536)` (Step 1), and `rag/ingest.py` embeds against the OpenAI endpoint with `OPENAI_API_KEY` from `.env.local`. Changing model means changing the column dimension (a migration plus an HNSW index rebuild plus a full re-embed), not just a config value. The `embedding_model` change key makes the re-embed automatic, but not the column type change.
2. **The ingest job is deliberately stdlib + `requests` only** (no openai / supabase SDK). Any provider that cannot be called with a plain HTTPS request and a bearer token breaks that.

> **What's "the OpenAI key" here (it is not an embedding-specific key):**
> An OpenAI account has one API key, not one per feature. The same `sk-...` authorizes every OpenAI endpoint (chat/completions for the LLM, embeddings, images, and the rest); the only thing that changes is which endpoint the request is sent to. So "a key we already hold" means one account key, and this project points it at the embeddings endpoint only (the call-time LLM is Groq, on its own key). There is no separate "embedding key" to obtain, and no Anthropic or Groq equivalent to reuse: neither offers a text-embeddings endpoint, so the embeddings key has to be OpenAI's (or another embeddings vendor's from the table below).

| Model | Price / 1M tokens | Dimensions | Why not here (yet) |
|---|---|---|---|
| **OpenAI `text-embedding-3-small` (chosen)** | $0.02 | 1536 | n/a: matches the deployed `vector(1536)` schema, the live ingest code, and a key we already hold |
| Amazon Titan Text Embeddings V2 (Bedrock) | $0.02 | 1024 / 512 / 256 | Same price, comparable quality, but max 1024 dims forces a `vector(1536)` -> `vector(1024)` migration + full re-embed; and Bedrock auth is AWS SigV4, so it needs an AWS account, IAM setup, and either boto3 (new heavy dep) or hand-rolled request signing. Three costs, zero gain |
| OpenAI `text-embedding-3-large` | $0.13 | 3072 | 6.5x the price for a few benchmark points that a ~100-chunk corpus cannot surface; also a dimension migration |
| Voyage 4 family | $0.02-0.12 | varies | Strong retrieval benchmarks, but a new vendor + key for a gain our corpus cannot measure |
| Cohere `embed-v4` | $0.12 | varies | Multilingual strength is its edge; our KBs and calls are English today |
| Hosted free tiers (Gemini free tier, Cohere trial, Voyage trial credit, Jina non-commercial) | $0 | varies | Free tiers trade ToS or data for price: Gemini's free tier may use request data for training (customer KBs cannot go there), Cohere's trial key is evaluation-only, Voyage's credit is one-time, Jina's free API is non-commercial only. And there is nothing to save: our full-corpus re-embed costs under a cent |
| Self-hosted open-source (`bge-small-en-v1.5`, `all-MiniLM-L6-v2`, `nomic-embed-text`) | $0 for the model | 384-1024 | The model is free; the compute and the ops move to us (see the callout below). The one real thing it buys is removing the embeddings-API dependency, which would eliminate the mid-call outage failure mode in section 6; the costs are a resident model process on the SIP box, somewhat lower retrieval quality at small dimensions, and the same column migration |

> **What's "the compute and the ops move to us":**
> Embedding is matrix math that has to run somewhere. With a hosted API, it runs on the provider's servers, and the per-token price is what pays for it. Self-hosting moves two things onto our side.
>
> **Compute:** the model loads into RAM (hundreds of MB even for a small model) and every embed call spends our CPU, on the same box that already runs Asterisk, the bridge script, and the demo server. Ingest-side this is easy (a GitHub Action embedding ~100 chunks on CPU is fine, and a short query embeds locally in ~10-30ms, often faster than an API round-trip).
>
> **Ops:** keeping that model process alive becomes our job, and the query-time embed sits on the call path (section 6), so a dead model process means dead retrieval mid-call. Concretely:
>
> | Concern | Hosted API | Self-hosted |
> |---|---|---|
> | Process dies at night | not our problem | retrieval fails on live calls until someone restarts it |
> | Environment setup | none | PyTorch + model libs, several GB of dependencies |
> | Upgrades | provider's job | we track versions and re-test |
> | Redeploy on a new box | change a key | reinstall the whole environment |
> | Debugging failures | file a ticket | us |
>
> For a two-person AI team, that ops load costs more than an API bill measured in cents per month. This is why "free" does not win here: the money moves from the API bill into compute and ops instead of disappearing.

**Verdict on Titan V2:** it would work, and on price it ties exactly with what we run. But it buys nothing (same cost, no quality edge at this scale) and charges three integration costs: a schema migration, a new cloud vendor with IAM, and a heavier ingest job. The case for it appears only if the company standardizes on AWS (for example the LLM moves to Bedrock, or AWS credits arrive), in which case the `embedding_model` change key plus one column migration make the switch contained.

**When we would revisit:** infra consolidates on AWS/Bedrock; KBs become seriously multilingual (re-evaluate Cohere/Voyage then); the retrieval eval (section 9) shows quality failures that a stronger model could plausibly fix; or the embeddings-API outage failure mode (section 6) becomes a real reliability concern, in which case self-hosted local embedding is the fix to price out.
