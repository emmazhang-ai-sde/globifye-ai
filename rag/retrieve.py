#!/usr/bin/env python3
"""RAG retrieval smoke test -- the read side of the simplest RAG MVP.

Embeds a caller question, ranks a company's `detail` chunks by cosine
similarity, and prints the top-k. This is a standalone slice of RAG Step 3:
no query rewrite, no prompt injection, not wired into the call path. It exists
to prove the RAG loop works end to end (ingest writes vectors -> a question
retrieves the right sections).

MVP shortcut (honest): the cosine ranking is done CLIENT-SIDE. At ~50 detail
chunks per company, fetching them all and ranking in Python needs no Postgres
RPC and no extra DDL -- one fewer moving part. Production Step 3 pushes the
`<=>` cosine operator into Postgres (the HNSW index) for scale; the cosine
result is identical.

Usage:
  venv/bin/python3 -u rag/retrieve.py pacificbeef "what cuts do you sell?"
  venv/bin/python3 -u rag/retrieve.py globifye "how much does it cost?" -k 3
"""
import argparse
import math
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest  # reuse env loading, embed(), and the Supabase auth helpers


def parse_vec(v) -> list[float]:
    """PostgREST returns a vector column as the text '[0.1,0.2,...]'."""
    if isinstance(v, list):
        return [float(x) for x in v]
    return [float(x) for x in v.strip().lstrip("[").rstrip("]").split(",")]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def fetch_detail(company: str) -> list[dict]:
    r = requests.get(
        f"{ingest._sb_base()}/sip_kb_chunks",
        headers=ingest._sb_headers(),
        params={
            "company_key": f"eq.{company}",
            "kind": "eq.detail",
            "select": "source_file,section,content,embedding",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def main() -> int:
    ap = argparse.ArgumentParser(description="RAG retrieval smoke test")
    ap.add_argument("company", help="company_key, e.g. pacificbeef")
    ap.add_argument("query", help="the caller's question, quoted")
    ap.add_argument("-k", type=int, default=3, help="how many chunks to return (default 3)")
    args = ap.parse_args()

    if not ingest.OPENAI_KEY:
        raise SystemExit("OPENAI_API_KEY missing in ai-pipeline/.env.local")

    rows = fetch_detail(args.company)
    if not rows:
        raise SystemExit(
            f"No detail chunks for '{args.company}'. Run the ingest first:\n"
            f"  venv/bin/python3 -u rag/ingest.py"
        )

    qvec = ingest.embed([args.query])[0]
    scored = sorted(
        ((cosine(qvec, parse_vec(row["embedding"])), row) for row in rows),
        key=lambda t: t[0],
        reverse=True,
    )

    print(f"query:   {args.query!r}")
    print(f"company: {args.company}   detail chunks searched: {len(rows)}\n")
    for i, (sim, row) in enumerate(scored[: args.k], 1):
        preview = row["content"].replace("\n", " ")[:160]
        print(f"#{i}  cos={sim:.3f}  {row['source_file']} [{row['section']}]")
        print(f"     {preview}...\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
