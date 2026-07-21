#!/usr/bin/env python3
"""RAG Build, Step 2 -- the daily ingest job.

Reads every company's knowledge-base corpus (the per-company FOLDERS under
sip/knowledge-base/, NOT the legacy single-file KBs), chunks each document by
markdown section, tags each chunk core/detail, embeds it with OpenAI
text-embedding-3-small, and UPSERTs the result into `sip_kb_chunks` in the
merged Supabase project.

This is the write side of the RAG design. It runs OFF the call path (a daily
GitHub Action, or by hand), so no embedding ever happens during a live call.
The read side (call-time retrieval) is RAG Step 3.

Design doc: ../design-docs-sip/... -> see
  design-docs-rag/rag-per-company-knowledge-base-design-doc.md (section 5)
Step doc:   design-docs-rag/rag-build-step-by-step/step2-ingest-job.md
Schema:     sip/rag/rag-schema.sql (RAG Step 1 -- must be applied first)

CORE vs DETAIL (decision recorded in the step doc, "Decision 1"; updated 2026-07-21):
  Each company folder holds a `sales-playbook.md` whose four sections (sales
  pipeline, qualifying questions, objection handling, when-you-don't-know) the
  tagger marks `core`; every other corpus file is `detail`. So this job writes
  both: `core` rows (the always-injected playbook) and `detail` rows (the
  retrieved facts). Decision 1 was originally detail-only with the playbook static
  in code; it moved to a per-folder playbook doc (Option 3) once each company
  needed its own `core` in the DB for call-time retrieval (Step 3 fetches
  kind='core'). See tag_kind().

Zero heavy deps: stdlib + `requests` only (no openai / supabase SDK), matching
the SIP scripts. Keys load from ai-pipeline/.env.local, falling back to the
process environment (how CI injects repo secrets - RAG Step 5).

Usage:
  venv/bin/python3 -u sip/rag/ingest.py --dry-run          # chunk/tag/embed, no DB writes
  venv/bin/python3 -u sip/rag/ingest.py                     # full live ingest (needs the table)
  venv/bin/python3 -u sip/rag/ingest.py --company pacificbeef
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

import requests

# --------------------------------------------------------------------------- #
# Paths and config
# --------------------------------------------------------------------------- #
def _find_repo_root(start: Path) -> Path:
    """Walk up to the globifye-ai dir (the one holding both the KB corpus and
    ai-pipeline). Robust to this script being moved between rag/ and sip/rag/."""
    for d in [start, *start.parents]:
        if (d / "sip" / "knowledge-base").is_dir() and (d / "ai-pipeline").is_dir():
            return d
    return start.parents[1]


REPO = _find_repo_root(Path(__file__).resolve())
KB_DIR = REPO / "sip" / "knowledge-base"
ENV_PATH = REPO / "ai-pipeline" / ".env.local"

EMBED_MODEL = "text-embedding-3-small"
EMBED_DIM = 1536                                     # must match the vector(1536) column
EMBED_ENDPOINT = "https://api.openai.com/v1/embeddings"
EMBED_BATCH = 128                                    # inputs per API call (cap is 2048; small is fine)

MAX_CHUNK_TOKENS = 400                               # a section over this is sub-split at paragraphs
CHARS_PER_TOKEN = 4                                  # rough estimate (no tiktoken dep)

# A chunk is `core` iff its section title matches one of the playbook markers.
# These are the shared-KB-template playbook titles from the design doc (section
# 2.1). Each company's sales-playbook.md carries exactly these titles, so its
# sections tag `core`; every other corpus file tags `detail`.
CORE_TITLE_MARKERS = (
    "sales pipeline",
    "qualifying question",
    "objection",
    "when you don't know",
)

# Files we ingest. The corpus is markdown today; pdf/docx loaders are wired but
# lazy-imported, so they only need pypdf / python-docx installed if such a file
# actually appears.
SUPPORTED_SUFFIXES = (".md", ".pdf", ".docx")


# --------------------------------------------------------------------------- #
# Environment (tiny parser -- same approach as the SIP scripts, no python-dotenv)
# --------------------------------------------------------------------------- #
def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env(ENV_PATH)


def _key(*names: str) -> str:
    """Resolve a credential: .env.local first (local dev), then the process
    environment (CI, where repo secrets arrive as env vars). First hit wins."""
    for source in (ENV, os.environ):
        for n in names:
            v = source.get(n, "").strip()
            if v:
                return v
    return ""


OPENAI_KEY = _key("OPENAI_API_KEY")
SUPABASE_URL = _key("SUPABASE_SIP_URL", "NEXT_PUBLIC_SUPABASE_URL").rstrip("/")
SUPABASE_KEY = _key("SUPABASE_SIP_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY")


# --------------------------------------------------------------------------- #
# Discover -- corpus is the per-company FOLDERS only
# --------------------------------------------------------------------------- #
def discover(only_company: str | None = None) -> dict[str, list[Path]]:
    """Return {company_key: [files]} for each company FOLDER under the KB dir.
    The folder name is the company_key. The top-level single-file KBs
    (pacificbeef.md, globifye.md) are the legacy live-injection KBs and are
    deliberately excluded -- they are not the RAG corpus."""
    companies: dict[str, list[Path]] = {}
    for entry in sorted(KB_DIR.iterdir()):
        if not entry.is_dir():
            continue
        if only_company and entry.name != only_company:
            continue
        files = [
            p for p in sorted(entry.rglob("*"))
            if p.is_file() and p.suffix.lower() in SUPPORTED_SUFFIXES
        ]
        if files:
            companies[entry.name] = files
    return companies


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --------------------------------------------------------------------------- #
# Load -- one loader per suffix
# --------------------------------------------------------------------------- #
def load_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".md":
        return path.read_text(encoding="utf-8")
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            raise SystemExit(f"{path.name}: PDF ingest needs `pip install pypdf`")
        reader = PdfReader(str(path))
        return "\n\n".join((page.extract_text() or "") for page in reader.pages)
    if suffix == ".docx":
        try:
            import docx
        except ImportError:
            raise SystemExit(f"{path.name}: DOCX ingest needs `pip install python-docx`")
        return "\n".join(p.text for p in docx.Document(str(path)).paragraphs)
    raise SystemExit(f"{path.name}: unsupported file type {suffix}")


# --------------------------------------------------------------------------- #
# Chunk -- markdown by `##` section; a long section is sub-split at paragraphs,
# never mid-table. Each chunk is prefixed with "doc title > section" so the
# heading (the strongest retrieval signal) rides inside the embedded text.
# --------------------------------------------------------------------------- #
def estimate_tokens(text: str) -> int:
    return max(1, len(text) // CHARS_PER_TOKEN)


def _hard_window(text: str) -> list[str]:
    """Last-resort split of a single over-long unit (e.g. a PDF run-on line with
    no newlines) into fixed character windows."""
    size = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN
    return [text[i:i + size] for i in range(0, len(text), size)] or [text]


def _atomic_units(body: str) -> list[str]:
    """Break a section body into units no larger than the budget, without ever
    splitting a markdown table mid-row.

    Levels, applied only when a unit is still over budget:
      1. blank-line paragraphs
      2. line boundaries (a run of '|' table rows stays as one atomic unit)
      3. a fixed character window (a single non-table line with no breaks)"""
    units: list[str] = []
    for para in re.split(r"\n\s*\n", body.strip()):
        para = para.strip()
        if not para:
            continue
        if estimate_tokens(para) <= MAX_CHUNK_TOKENS:
            units.append(para)
            continue
        # over-budget paragraph -> split by lines, keeping table rows together
        table: list[str] = []
        for line in para.split("\n"):
            is_table_row = line.lstrip().startswith("|")
            if is_table_row:
                table.append(line)
                continue
            if table:
                units.append("\n".join(table))  # a table is never char-split
                table = []
            if estimate_tokens(line) <= MAX_CHUNK_TOKENS:
                units.append(line)
            else:
                units.extend(_hard_window(line))
        if table:
            units.append("\n".join(table))
    return [u for u in units if u.strip()]


def _split_long_section(body: str) -> list[str]:
    """Pack a section's atomic units into chunks up to the token budget."""
    parts: list[str] = []
    cur: list[str] = []
    cur_tok = 0
    for unit in _atomic_units(body):
        utok = estimate_tokens(unit)
        if cur and cur_tok + utok > MAX_CHUNK_TOKENS:
            parts.append("\n\n".join(cur))
            cur, cur_tok = [], 0
        cur.append(unit)
        cur_tok += utok
    if cur:
        parts.append("\n\n".join(cur))
    return parts or [body.strip()]


def chunk_markdown(text: str) -> list[tuple[str, str]]:
    """Return a list of (section_title, chunk_content) for a markdown document,
    in document order."""
    lines = text.splitlines()
    doc_title = ""
    for ln in lines:
        if ln.startswith("# "):
            doc_title = ln[2:].strip()
            break

    # Cut the document into (## section title, body) blocks. Text before the
    # first `##` becomes an "(overview)" block if it carries real content.
    sections: list[tuple[str, str]] = []
    cur_title = "(overview)"
    cur_body: list[str] = []

    def flush():
        body = "\n".join(cur_body).strip()
        # drop the H1 line itself from the overview body -- it is already the prefix
        if body and not (cur_title == "(overview)" and body == f"# {doc_title}"):
            sections.append((cur_title, body))

    for ln in lines:
        if ln.startswith("## "):
            flush()
            cur_title = ln[3:].strip()
            cur_body = []
        else:
            cur_body.append(ln)
    flush()

    chunks: list[tuple[str, str]] = []
    for title, body in sections:
        # strip a lone leading H1 out of the overview body
        body = re.sub(r"^#\s+.*\n?", "", body).strip()
        if not body:
            continue
        prefix = f"{doc_title} > {title}" if doc_title else title
        pieces = [body] if estimate_tokens(body) <= MAX_CHUNK_TOKENS else _split_long_section(body)
        for piece in pieces:
            chunks.append((title, f"{prefix}\n\n{piece}"))
    return chunks


def tag_kind(section_title: str) -> str:
    t = section_title.lower()
    return "core" if any(m in t for m in CORE_TITLE_MARKERS) else "detail"


# --------------------------------------------------------------------------- #
# Embed -- OpenAI text-embedding-3-small over raw HTTP, batched
# --------------------------------------------------------------------------- #
def embed(texts: list[str]) -> list[list[float]]:
    if not OPENAI_KEY:
        raise SystemExit("OPENAI_API_KEY missing in ai-pipeline/.env.local")
    out: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = texts[i:i + EMBED_BATCH]
        r = requests.post(
            EMBED_ENDPOINT,
            headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
            json={"model": EMBED_MODEL, "input": batch},
            timeout=60,
        )
        r.raise_for_status()
        data = sorted(r.json()["data"], key=lambda d: d["index"])
        for d in data:
            vec = d["embedding"]
            if len(vec) != EMBED_DIM:
                raise SystemExit(f"embedding dim {len(vec)} != expected {EMBED_DIM}")
            out.append(vec)
    return out


def vec_to_pg(vec: list[float]) -> str:
    """pgvector's text input form: '[0.1,0.2,...]'. PostgREST sends this string
    and Postgres casts it into the vector column."""
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


# --------------------------------------------------------------------------- #
# Supabase -- proven pattern copied from demo_ui_server.py (auth subtlety: a
# Bearer header only for legacy eyJ... JWT keys; sb_secret_... uses apikey alone)
# --------------------------------------------------------------------------- #
def _sb_headers(extra=None) -> dict:
    h = {"apikey": SUPABASE_KEY, "Content-Type": "application/json"}
    if SUPABASE_KEY.startswith("eyJ"):
        h["Authorization"] = f"Bearer {SUPABASE_KEY}"
    if extra:
        h.update(extra)
    return h


def _sb_base() -> str:
    if not (SUPABASE_URL and SUPABASE_KEY):
        raise SystemExit("Supabase URL/key missing in ai-pipeline/.env.local")
    return f"{SUPABASE_URL}/rest/v1"


def fetch_stored_hashes(company: str) -> dict[str, str]:
    """source_file -> content_hash for a company (used to skip unchanged files).
    All chunks of a file share the hash, so one row per file is enough."""
    r = requests.get(
        f"{_sb_base()}/sip_kb_chunks",
        headers=_sb_headers(),
        params={
            "company_key": f"eq.{company}",
            "select": "source_file,content_hash,embedding_model",
        },
        timeout=30,
    )
    r.raise_for_status()
    stored: dict[str, str] = {}
    for row in r.json():
        # only trust the stored hash when the embedding model also matches
        if row.get("embedding_model") == EMBED_MODEL:
            stored[row["source_file"]] = row["content_hash"]
    return stored


def upsert_rows(rows: list[dict]) -> None:
    for i in range(0, len(rows), 200):
        r = requests.post(
            f"{_sb_base()}/sip_kb_chunks",
            headers=_sb_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            params={"on_conflict": "company_key,source_file,chunk_index"},
            json=rows[i:i + 200],
            timeout=60,
        )
        r.raise_for_status()


def delete_where(params: dict) -> None:
    r = requests.delete(
        f"{_sb_base()}/sip_kb_chunks",
        headers=_sb_headers({"Prefer": "return=minimal"}),
        params=params,
        timeout=30,
    )
    r.raise_for_status()


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def build_file_chunks(company: str, path: Path):
    """Load + chunk + tag one file. Returns (content_hash, [chunk dicts without
    embeddings])."""
    content_hash = sha256_file(path)
    source_file = str(path.relative_to(KB_DIR))          # e.g. "pacificbeef/product-catalog.md"
    text = load_text(path)
    # All file types go through the same splitter. Markdown uses its `##`
    # headings; a heading-less file (extracted PDF/DOCX text) falls through to
    # the "(overview)" path and is size-split at ~400 tokens -- the window
    # fallback the design intends for headerless documents.
    rows = []
    for idx, (section, content) in enumerate(chunk_markdown(text)):
        rows.append({
            "company_key": company,
            "source_file": source_file,
            "chunk_index": idx,
            "kind": tag_kind(section),
            "section": section,
            "content": content,
            "content_hash": content_hash,
            "embedding_model": EMBED_MODEL,
        })
    return content_hash, rows


def run(dry_run: bool, only_company: str | None) -> int:
    companies = discover(only_company)
    if not companies:
        print(f"No corpus folders found under {KB_DIR}")
        return 1

    can_embed = bool(OPENAI_KEY)
    if not dry_run and not can_embed:
        raise SystemExit("OPENAI_API_KEY missing in ai-pipeline/.env.local (required for a live ingest)")

    mode = "DRY-RUN (no DB writes)" if dry_run else "LIVE"
    print(f"RAG ingest -- {mode}")
    print(f"  corpus:  {KB_DIR}")
    print(f"  model:   {EMBED_MODEL}  (dim {EMBED_DIM})")
    print(f"  target:  {SUPABASE_URL or '(none)'}")
    if not can_embed:
        print("  embed:   SKIPPED (no OPENAI_API_KEY) -- chunk/tag plan only")
    print()

    grand = {"files": 0, "skipped": 0, "chunks": 0, "core": 0, "detail": 0, "embedded": 0}
    sample_shown = False

    for company, files in companies.items():
        stored = {} if dry_run else fetch_stored_hashes(company)
        seen_files = set()
        c_chunks = c_core = c_files = c_skipped = 0

        for path in files:
            source_file = str(path.relative_to(KB_DIR))
            seen_files.add(source_file)
            content_hash, rows = build_file_chunks(company, path)

            if not dry_run and stored.get(source_file) == content_hash:
                c_skipped += 1
                grand["skipped"] += 1
                continue

            # embed (proves the OpenAI key + dimension); skipped only in dry-run
            # when no key is set, so the chunk/tag plan is still verifiable.
            if can_embed:
                vectors = embed([r["content"] for r in rows])
                for r, v in zip(rows, vectors):
                    r["embedding"] = vec_to_pg(v)
                grand["embedded"] += len(rows)

            if not dry_run:
                upsert_rows(rows)
                delete_where({                            # prune a shrunk file's tail
                    "company_key": f"eq.{company}",
                    "source_file": f"eq.{source_file}",
                    "chunk_index": f"gte.{len(rows)}",
                })

            c_files += 1
            c_chunks += len(rows)
            c_core += sum(1 for r in rows if r["kind"] == "core")
            grand["files"] += 1
            grand["chunks"] += len(rows)
            grand["core"] += sum(1 for r in rows if r["kind"] == "core")
            grand["detail"] += sum(1 for r in rows if r["kind"] == "detail")

            if not sample_shown and rows:
                r0 = rows[0]
                print("  sample chunk ------------------------------------------")
                print(f"    {r0['source_file']} [#{r0['chunk_index']}] kind={r0['kind']} "
                      f"section={r0['section']!r}")
                preview = r0["content"].replace("\n", " ")[:180]
                print(f"    content: {preview}...")
                if "embedding" in r0:
                    print(f"    embedding: dim {len(r0['embedding'].split(','))}, "
                          f"head {r0['embedding'][:40]}...")
                print("  -------------------------------------------------------")
                sample_shown = True

        # prune whole files that were deleted from disk
        if not dry_run:
            for gone in set(stored) - seen_files:
                delete_where({"company_key": f"eq.{company}", "source_file": f"eq.{gone}"})

        print(f"  {company:12} files={c_files} skipped={c_skipped} "
              f"chunks={c_chunks} (core={c_core} detail={c_chunks - c_core})")

    print(f"\nTOTAL  files={grand['files']} skipped(unchanged)={grand['skipped']} "
          f"chunks={grand['chunks']} core={grand['core']} detail={grand['detail']} "
          f"embedded={grand['embedded']}")
    if dry_run:
        print("DRY-RUN: nothing written. Apply RAG Step 1, then re-run without --dry-run.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="RAG Step 2 -- ingest KB corpus into sip_kb_chunks")
    ap.add_argument("--dry-run", action="store_true",
                    help="chunk/tag/embed and print a plan, but write nothing to the DB")
    ap.add_argument("--company", help="ingest only this company folder (e.g. pacificbeef)")
    args = ap.parse_args()
    return run(dry_run=args.dry_run, only_company=args.company)


if __name__ == "__main__":
    sys.exit(main())
