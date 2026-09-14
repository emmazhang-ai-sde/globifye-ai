#!/usr/bin/env python3
"""Call-time RAG retrieval for the SIP phone agent.

This is the read side of the company KnowledgeBaseResource. The model supplies
only a natural-language query; company scope comes from RuntimeContext through
the capability executor.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path
from typing import Any

import requests


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "rag"))
import ingest  # noqa: E402


NO_MATCH_FLOOR = {"pacificbeef": 0.625, "globifye": 0.677}
DEFAULT_FLOOR = 0.65

_FOLLOWUP_OPENERS = (
    "and ",
    "what about",
    "how about",
    "how much",
    "how many",
    "what's that",
    "that one",
    "that ",
    "those ",
    "it ",
    "is it",
)


def should_retrieve(text: str) -> bool:
    """Cheap gate for utterances too small to be meaningful KB lookups."""

    return len(text.strip().split()) >= 2


def is_followup(text: str) -> bool:
    t = text.strip().lower()
    return len(t.split()) <= 4 or t.startswith(_FOLLOWUP_OPENERS)


def build_query(text: str, prev_user: str = "") -> str:
    """No-model follow-up rewrite used when a short question needs context."""

    if prev_user and is_followup(text):
        return f"{prev_user.strip()} {text.strip()}"
    return text.strip()


def match_detail(
    company_key: str,
    query: str,
    k: int = 3,
    *,
    distance_floor: float | None = None,
    prefer_rpc: bool = True,
) -> list[dict[str, Any]]:
    """Return trusted detail chunks for one company.

    The preferred path uses the Postgres ``match_kb_chunks`` RPC. If that RPC is
    not available in a local Supabase project, we fall back to the client-side
    cosine ranking used by ``rag/retrieve.py``.
    """

    if not ingest.OPENAI_KEY:
        raise RuntimeError("OPENAI_API_KEY missing -- cannot embed the query")

    query = query.strip()
    if not should_retrieve(query):
        return []

    qvec = ingest.embed([query])[0]
    floor = distance_floor if distance_floor is not None else NO_MATCH_FLOOR.get(company_key, DEFAULT_FLOOR)

    if prefer_rpc:
        try:
            rows = _rpc_match_detail(company_key=company_key, query_embedding=qvec, k=k)
        except requests.HTTPError as exc:
            if not _can_fallback_from_rpc_error(exc):
                raise
            rows = _client_side_match_detail(company_key=company_key, query_embedding=qvec, k=k)
    else:
        rows = _client_side_match_detail(company_key=company_key, query_embedding=qvec, k=k)

    normalized = [_normalize_chunk(row) for row in rows]
    return [row for row in normalized if row.get("distance", 1.0) <= floor]


def render(chunks: list[dict[str, Any]]) -> str:
    """Turn retrieved chunks into a prompt/tool-result evidence block."""

    return "\n\n".join(str(chunk.get("content") or "") for chunk in chunks if chunk.get("content"))


def _rpc_match_detail(
    *,
    company_key: str,
    query_embedding: list[float],
    k: int,
) -> list[dict[str, Any]]:
    r = requests.post(
        f"{ingest._sb_base()}/rpc/match_kb_chunks",
        headers=ingest._sb_headers(),
        json={
            "p_company_key": company_key,
            "p_query_embedding": ingest.vec_to_pg(query_embedding),
            "p_match_count": k,
        },
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def _client_side_match_detail(
    *,
    company_key: str,
    query_embedding: list[float],
    k: int,
) -> list[dict[str, Any]]:
    r = requests.get(
        f"{ingest._sb_base()}/sip_kb_chunks",
        headers=ingest._sb_headers(),
        params={
            "company_key": f"eq.{company_key}",
            "kind": "eq.detail",
            "select": "id,source_file,section,content,embedding",
        },
        timeout=30,
    )
    r.raise_for_status()
    scored = sorted(
        (
            {
                **row,
                "distance": 1.0 - _cosine(query_embedding, _parse_vec(row["embedding"])),
            }
            for row in r.json()
            if row.get("embedding")
        ),
        key=lambda row: row["distance"],
    )
    return scored[:k]


def _normalize_chunk(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "source_file": row.get("source_file"),
        "section": row.get("section"),
        "content": row.get("content", ""),
        "distance": float(row.get("distance", 1.0)),
    }


def _parse_vec(value: Any) -> list[float]:
    if isinstance(value, list):
        return [float(x) for x in value]
    return [float(x) for x in str(value).strip().lstrip("[").rstrip("]").split(",")]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _can_fallback_from_rpc_error(exc: requests.HTTPError) -> bool:
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    if status_code in {400, 404}:
        return True
    body = getattr(response, "text", "") if response is not None else ""
    return "match_kb_chunks" in body and "function" in body.lower()


__all__ = [
    "DEFAULT_FLOOR",
    "NO_MATCH_FLOOR",
    "build_query",
    "is_followup",
    "match_detail",
    "render",
    "should_retrieve",
]
