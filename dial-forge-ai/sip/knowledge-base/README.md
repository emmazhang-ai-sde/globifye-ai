# Knowledge bases

Per-company knowledge for the SIP voice agent. `companies.json` maps each company key to its display name, extension, TTS voice, legacy `kb_file`, and `knowledge_profile_id`.

## Runtime vocabulary

The current files are moving toward this vocabulary:

| Term | Meaning |
|---|---|
| `KnowledgeBaseResource` | The company-scoped information asset: source files, chunks, embeddings, retrieval policy, fallback policy, status, and version. |
| `RetrievalCapability` | The controlled runtime access path into a KB resource, such as `retrieve_company_kb(query)`. It is an information capability, not another copy of the information. |
| `RuntimeCapability` | A capability the LLM may be allowed to call on a turn. Initial kinds are `information`, `state`, `human`, and `action`. |
| `RuntimeContext` | The call/session context used to decide which capabilities are exposed: agent config, company scope, owner, stage, and bound KBs. |

Layering rule:

```text
KnowledgeBaseResource stores company information.
RetrievalCapability retrieves that information through a controlled interface.
RuntimeCapability is what the model may call.
```

The model should never choose the company scope for retrieval. `company_key` comes from the active runtime context.

## Three layers

**Live (today): single-file KB.** `pacificbeef.md` and `globifye.md` are what the bridge injects into the LLM prompt on a call, chosen by the dialed number. This is the full-prompt-injection design in use now.

**Profile config (Phase 2): explicit KB resource binding.** `knowledge_profiles.json` defines each `KnowledgeBaseResource`: company scope, legacy file, corpus path, source files, retrieval policy, fallback policy, status, and version. `companies.json` keeps only the agent routing fields plus `knowledge_profile_id`.

**Corpus (RAG source material): per-company folder.** `pacificbeef/` and `globifye/` each hold 10 documents — a plausible, simulated multi-document knowledge base modeled on the kind of content real American beef exporters and AI-voice SaaS providers publish. These are the source material for the retrieval work: the folder name is the `company_key`, and the RAG ingest job (see `../../design-docs-rag/rag-per-company-kb-design-doc.md`, built in `../../design-docs-rag/rag-build-step-by-step/`) chunks and embeds these files. Not wired into the live call path yet.

| Company | Knowledge profile | Live KB | Corpus folder (10 docs) |
|---|---|---|---|
| Pacific Beef Trading | `pacificbeef` | `pacificbeef.md` | `pacificbeef/` |
| GlobiFYE (DialForge) | `globifye` | `globifye.md` | `globifye/` |

The corpus content is **simulated** for demo and development. Companies, prices, certifications, and specifics are fictional.
