# Knowledge bases

Per-company knowledge for the SIP voice agent. `companies.json` maps each company key to its display name, extension, TTS voice, and `kb_file`.

## Two layers

**Live (today): single-file KB.** `pacificbeef.md` and `globifye.md` are what the bridge injects into the LLM prompt on a call, chosen by the dialed number. This is the full-prompt-injection design in use now.

**Corpus (next step, RAG): per-company folder.** `pacificbeef/` and `globifye/` each hold 10 documents — a plausible, simulated multi-document knowledge base modeled on the kind of content real American beef exporters and AI-voice SaaS providers publish. These are the source material for the retrieval work: the folder name is the `company_key`, and the RAG ingest job (see `../../design-docs-rag/rag-per-company-kb-design-doc.md`, built in `../../design-docs-rag/rag-build-step-by-step/`) chunks and embeds these files. Not wired into the live call path yet.

| Company | Live KB | Corpus folder (10 docs) |
|---|---|---|
| Pacific Beef Trading | `pacificbeef.md` | `pacificbeef/` |
| GlobiFYE (DialForge) | `globifye.md` | `globifye/` |

The corpus content is **simulated** for demo and development. Companies, prices, certifications, and specifics are fictional.
