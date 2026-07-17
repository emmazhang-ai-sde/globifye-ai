# RAG Build, Step 1 - Vector Table Schema Migration

**Parent doc:** [`../rag-per-company-kb-design-doc.md`](../rag-per-company-kb-design-doc.md) (section 4, data model)
**Schema file:** [`rag/rag-schema.sql`](../../rag/rag-schema.sql)
**Status: applied and verified 2026-07-16.**
**Goal:** create one empty, verified table - `sip_kb_chunks` - in the merged Supabase project, with vector support switched on. Nothing else.
**Non-goals:** no ingest, no embeddings, no retrieval, no data. This step only proves the storage works. Ingest is [Step 2](./step2-ingest-job.md); retrieval is [Step 3](./step3-call-time-retrieval.md).

## 1. Why this first

Everything downstream - ingest, retrieval, eval - needs somewhere to put and find the vectors, so the table comes first. It is also the zero-risk starting point: creating an empty table cannot affect a live call. We create it, prove it works end to end, and stop.

Two design choices worth understanding before touching it:

> **What's pgvector:**
> A Postgres extension that adds a vector column type and a "how close are these two vectors" operator. It is what lets us store an embedding per chunk and ask "which rows are closest to this question?" directly in SQL. It was not enabled on the project yet, so the schema switches it on.

> **What's the tenant boundary here:**
> Every read will filter to the one company answering the call. That filter is the isolation - not row-level security. The app connects with the service key, which bypasses RLS entirely, so a per-company RLS policy could not gate it anyway. Access is granted to the same service key the existing SIP tables already use, matching that convention. (This corrects the design doc's earlier "enable RLS by company" idea; the doc says the same now.)

About the columns (full definitions in the schema file): each chunk keeps a stable identity inside its file, so a re-ingest replaces rows in place instead of deleting and re-inserting; a `kind` column separates the always-injected playbook from retrievable detail; and the file fingerprint plus the embedding model together form the change key, so switching embedding models forces a clean full re-embed instead of silently mixing two models' vectors.

## 2. What was done, and where

| Where | What | Status |
|---|---|---|
| Supabase SQL editor | Run the schema file - creates the extension, the table, the access grant, and the indexes. Idempotent: safe to run more than once | done 2026-07-16 |
| Supabase SQL editor | Run the verification block (below) | done 2026-07-16, all checks passed |

## 3. What the verification proves

Three things, in one short SQL block (full text in the appendix):

1. **The vector extension is on** - the database understands the vector type at all.
2. **The table has the expected shape** - all columns present, so the ingest job's writes will land.
3. **A full round trip works** - insert one test row with a vector, find it again *by vector closeness*, delete it. This exercises the permissions, the vector type, and the distance search in a single pass; if all three pass, the store is genuinely ready, not just "created without error."

## Failures log

| Symptom | Cause | Fix |
|---|---|---|
| Round-trip check returned the row but the distance showed as empty/null instead of 0 (2026-07-16) | The first version of the self-test used an all-zero test vector. Cosine distance against a zero vector is mathematically undefined (a divide-by-zero), and the SQL editor renders that undefined result as null. The table and pgvector were fine - the test itself was flawed | Self-test switched to a unit vector, whose distance to itself is a real 0, so the check can genuinely pass or fail |

Likely ones to watch, from past Supabase work: a permission error on the insert means the access grant did not run (re-run the whole schema file, not just the table); an error on the vector value means the extension was not created first (run the file top to bottom).

## Appendix - the SQL (skip on a first read)

**The migration.** Open the SQL editor for the merged project - `https://supabase.com/dashboard/project/rjhjveatqnwxbnfrthsr/sql/new` - paste the full contents of [`rag/rag-schema.sql`](../../rag/rag-schema.sql), and run. Every statement is guarded, so re-running is a no-op.

**The verification block** - run in the same editor:

```sql
-- (1) extension is on
select extname, extversion from pg_extension where extname = 'vector';

-- (2) table has the 11 expected columns
select column_name, data_type
from information_schema.columns
where table_name = 'sip_kb_chunks'
order by ordinal_position;

-- (3) round-trip: insert one test chunk with a 1536-dim unit vector
--     [1,0,0,...], read it back by cosine distance, delete it.
insert into sip_kb_chunks
  (company_key, source_file, chunk_index, kind, section, content, content_hash, embedding_model, embedding)
values
  ('_selftest', 'selftest.md', 0, 'detail', 'test', 'hello world',
   repeat('0', 64), 'text-embedding-3-small',
   ('[1,' || array_to_string(array_fill(0, array[1535]), ',') || ']')::vector(1536));

select company_key, section, content,
       embedding <=> ('[1,' || array_to_string(array_fill(0, array[1535]), ',') || ']')::vector(1536) as distance
from sip_kb_chunks
where company_key = '_selftest'
order by embedding <=> ('[1,' || array_to_string(array_fill(0, array[1535]), ',') || ']')::vector(1536)
limit 1;

delete from sip_kb_chunks where company_key = '_selftest';
```

Expected: check (1) one row (`vector`, version like `0.8.x`); check (2) 11 rows (`id, company_key, source_file, chunk_index, kind, section, content, content_hash, embedding_model, embedding, updated_at`); check (3) the insert succeeds, the select returns the `_selftest / test / hello world` row with `distance = 0`, and the delete removes it.

> **Why a unit vector, not a zero vector (the bug in the failures log):**
> Cosine distance divides by each vector's length. A zero vector has length 0, so the result is 0/0 - undefined, shown as null. A unit vector's distance to itself is a real 0, so the check can actually pass or fail. Standalone proof: `select '[0,0,0]'::vector <=> '[0,0,0]'::vector, '[1,0,0]'::vector <=> '[1,0,0]'::vector;` gives null and 0.

## Next

[Step 2 - the ingest job](./step2-ingest-job.md): discover the KB files, chunk, tag, embed, and fill this table. (Automating that as a scheduled Action is [Step 5](./step5-ingest-github-action.md).)
