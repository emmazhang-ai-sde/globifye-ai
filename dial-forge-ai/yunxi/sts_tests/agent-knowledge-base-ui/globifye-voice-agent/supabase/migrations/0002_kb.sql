-- supabase/migrations/0002_kb.sql
-- Knowledge base storage + retrieval for the voice agent.
-- Assumes an existing `organizations` table (from your multi-tenant schema).

create extension if not exists vector;

-- One row per uploaded file.
create table if not exists documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  agent_id        uuid,                       -- null = shared library
  filename        text not null,
  byte_size       bigint,
  status          text not null default 'processing', -- processing | ready | error
  error           text,
  chunk_count     int  not null default 0,
  created_at      timestamptz not null default now()
);

-- One row per embedded chunk.
create table if not exists kb_chunks (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references documents (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  chunk_index     int  not null,
  content         text not null,
  embedding       vector (1536),              -- text-embedding-3-small
  created_at      timestamptz not null default now()
);

create index if not exists documents_org_idx on documents (organization_id);
create index if not exists kb_chunks_doc_idx  on kb_chunks (document_id);

-- Approximate-nearest-neighbour index for cosine distance.
create index if not exists kb_chunks_embedding_idx
  on kb_chunks using hnsw (embedding vector_cosine_ops);

-- Retrieval: nearest chunks to a query embedding, scoped to an org and
-- optionally to a set of attached document ids.
create or replace function match_kb_chunks (
  query_embedding vector (1536),
  match_count     int  default 6,
  filter_org      uuid default null,
  doc_ids         uuid[] default null
)
returns table (
  id          uuid,
  document_id uuid,
  content     text,
  similarity  float
)
language sql stable
as $$
  select
    c.id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from kb_chunks c
  where (filter_org is null or c.organization_id = filter_org)
    and (doc_ids   is null or c.document_id = any (doc_ids))
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
