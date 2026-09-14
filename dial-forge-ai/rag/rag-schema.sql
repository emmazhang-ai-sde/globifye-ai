-- GlobiFYE SIP -- RAG knowledge-base vectors, for the MERGED backend project:
--   https://supabase.com/dashboard/project/rjhjveatqnwxbnfrthsr/sql/new
--
-- One row per KB chunk. Written by the daily ingest job (RAG Step 2), read at
-- call time by vector similarity (RAG Step 3).
--
-- Tenant isolation is the `company_key` filter in every query (same model as the
-- rest of the SIP demo). The app connects with the service-role key, which
-- BYPASSES row-level security, so per-company RLS is not the boundary here; the
-- WHERE clause is. See the design doc, section 4.
--
-- Safe to run more than once.

-- pgvector: the vector column type + the <=> cosine-distance operator.
create extension if not exists vector;

create table if not exists sip_kb_chunks (
  id              bigint generated always as identity primary key,
  company_key     text not null,                    -- pacificbeef | globifye | ...
  source_file     text not null,                    -- "pacificbeef.md" (or later "pacificbeef/specs.pdf")
  chunk_index     int  not null,                    -- 0-based position within the file
  kind            text not null default 'detail',   -- 'core' (always injected) | 'detail' (retrieved)
  section         text,                             -- "Packages and pricing"
  content         text not null,
  content_hash    text not null,                    -- sha256 of the whole source file (change key)
  embedding_model text not null,                    -- e.g. "text-embedding-3-small" (part of the change key)
  embedding       vector(1536),                     -- must match embedding_model's dimension
  updated_at      timestamptz not null default now(),
  unique (company_key, source_file, chunk_index)    -- UPSERT target for the ingest job
);

-- Same grant convention as sip_calls: the service key does the writes/reads.
grant all on sip_kb_chunks to service_role;

-- Approximate-nearest-neighbour index for the cosine top-k query.
create index if not exists sip_kb_chunks_hnsw
  on sip_kb_chunks using hnsw (embedding vector_cosine_ops);

-- Speeds the ingest job's per-file compare/delete (Step 2).
create index if not exists sip_kb_chunks_company_file_idx
  on sip_kb_chunks (company_key, source_file);

-- Call-time retrieval RPC (RAG Step 3). The phone runtime passes the active
-- company_key from RuntimeContext; the model never supplies tenant scope.
drop function if exists match_kb_chunks(text, vector, int);
create or replace function match_kb_chunks(
  p_company_key text,
  p_query_embedding vector(1536),
  p_match_count int default 3
)
returns table (
  id bigint,
  source_file text,
  section text,
  content text,
  distance float
)
language sql stable as $$
  select id, source_file, section, content, embedding <=> p_query_embedding as distance
  from sip_kb_chunks
  where company_key = p_company_key and kind = 'detail'
  order by embedding <=> p_query_embedding
  limit p_match_count;
$$;

grant execute on function match_kb_chunks(text, vector, int) to service_role;
