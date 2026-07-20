# RAG Glossary

**Parent doc:** [`rag-per-company-kb-design-doc.md`](./rag-per-company-kb-design-doc.md)

Plain-language definitions of the terms used across the RAG design doc and build steps, each tied to what it means *in this project*. A running example threads through the three core actions: a caller asks **"what cuts do you sell?"**.

## The three actions of RAG

RAG = **R**etrieval-**A**ugmented **G**eneration: first *retrieve* the relevant KB pieces, then hand them to the LLM to *generate* the answer. Three verbs do the work:

| Term | Plain meaning | In this project | Side |
|---|---|---|---|
| **embed** / **embedding** | turn a piece of text into a list of numbers (a point in space); text with similar meaning lands close together | OpenAI `text-embedding-3-small` turns each KB chunk, and each caller question, into 1536 numbers | both |
| **ingest** | read source material in, process it, and store it | `rag/ingest.py` reads the KB markdown -> chunks -> embeds -> writes rows into `sip_kb_chunks` | **write** (offline, ahead of any call) |
| **retrieval** | fetch the closest-matching stored pieces for a query | at call time, embed the caller's question and pull the nearest `detail` chunks from `sip_kb_chunks` | **read** (live, during the call) |

The example, traced end to end:

- **embed:** "what cuts do you sell?" becomes `[-0.014, 0.039, ...]` (1536 numbers). The `product-catalog` section is also 1536 numbers; the two lists are close, so they are judged "about the same thing."
- **ingest** already ran offline and put all 109 chunk vectors into `sip_kb_chunks`.
- **retrieval** takes the question's vector and returns the 3 nearest `detail` chunks - here, the product catalog.

> **Why numbers at all:**
> A computer cannot directly compare "do two sentences mean the same thing," but it can compare "are two lists of numbers close." Embedding translates *meaning* into *coordinates*, so closeness of vectors stands in for closeness of meaning.

## Data and storage terms

| Term | Meaning here |
|---|---|
| **chunk** | one small piece of a document. Each KB file is split into chunks (by `##` section), and each chunk is embedded and retrieved on its own |
| **vector** | the list of numbers an embedding produces (1536 of them here). "Vector" and "embedding" mean the same thing |
| **dimension / `vector(1536)`** | how many numbers are in each vector. `text-embedding-3-small` produces 1536, and the DB column must match |
| **embedding model** | the model that produces the vectors (`text-embedding-3-small`). Stored vectors and query vectors must come from the *same* model to be comparable |
| **`core` vs `detail`** | a tag on each chunk. `core` = the sales playbook, always injected; `detail` = facts (products, pricing, specs), retrieved only when relevant |
| **`company_key`** | which business a chunk belongs to (`pacificbeef`, `globifye`). Every query filters by it, which is also the tenant boundary: one business never sees another's KB |
| **`sip_kb_chunks`** | the Supabase table that holds one row per chunk (company, kind, section, content, vector) |
| **upsert** | update-or-insert: write a row, replacing it in place if it already exists. Ingest upserts so no chunk vanishes mid-call |
| **content hash** | a short fingerprint (sha256) of a file. If the fingerprint is unchanged, the file did not change, so ingest skips re-embedding it |
| **pgvector** | the Postgres extension that adds the `vector` column type and the `<=>` distance operator, so vector search runs inside SQL |
| **HNSW index** | the index pgvector uses to find nearest vectors fast, without scanning every row |

## Retrieval terms

| Term | Meaning here |
|---|---|
| **query** | the text we search with - the caller's question (after any rewrite) |
| **query rewrite** | turning a follow-up ("and how much is that?") into a standalone question before embedding, so it retrieves well |
| **top-k / `k`** | keep only the k nearest chunks. We use `k=3` |
| **cosine similarity** | a score for how closely two vectors point the same way (higher = more similar) |
| **cosine distance (`<=>`)** | 1 minus similarity (lower = more similar). pgvector's `<=>` operator returns this, so the nearest chunks come first |
| **distance floor** | a cutoff: if even the nearest chunk is farther than the floor, treat it as "no match" and fall back to the fallback line |
| **`top-k over kind='detail'`** | fetch the k nearest chunks, but only among `detail` chunks - the `core` playbook is always injected, never retrieved |

## See also

- The whole flow these terms describe: design doc [section 2 (Pipeline)](./rag-per-company-kb-design-doc.md).
- Why this stack (pgvector, `text-embedding-3-small`): [`rag-stack-evaluation.md`](./rag-stack-evaluation.md).
