# GlobiFYE Git Push & Sync Workflow

**Author:** Shuyang Zhang (AI)
**Last updated:** 2026-07-17

**Goal of this doc:** Explain how the AI-team code lives inside the shared company repo (`dial-forge`), how to push to it, and how a private full mirror is kept in a personal GitHub repo. Covers the folder layout, the two-remote setup, the daily push/pull commands, and the auth setup, so the same machine (or a new one) can be configured the same way.

**Non-goals:** This is not about the app code itself (SIP, RAG, ai-pipeline). Nothing here changes how the code runs, only how it is version-controlled and shared.

---

## 1. Why this setup

The AI project began as a standalone repo. The company later created a shared repo `dial-forge`, where the frontend team had already pushed a landing page and a login page. Two things had to be true at the same time:

1. AI code and frontend code must live in one shared repo without stepping on each other.
2. A private backup of everything (AI + frontend) should stay in a personal GitHub account.

The setup has three moving parts:

| Part | Choice | Why |
|------|--------|-----|
| Separate code inside one repo | AI code sits in a `dial-forge-ai/` subfolder; frontend files stay at the repo root | Both teams push to the same repo; each side edits only its own area, so pushes do not collide |
| Two remotes on one local clone | `company` = shared `dial-forge`, `origin` = personal `globifye-ai` | One folder, one commit history, both repos kept in sync |
| Push to both at once | The `company` remote is given two push URLs | `git push company main` updates the shared repo AND the personal mirror in one command |

> **What's a "remote":**
> A remote is a named pointer to a GitHub repo. `company` and `origin` are just labels for two GitHub URLs. `git push company main` means "send my main branch to the repo labeled company".

---

## 2. The layout

Local machine:

```
/Users/shuyangzhang/GlobiFYE/
├── dial-forge/            <- work here (a clone of the shared repo)
│   ├── dial-forge-ai/     <- all AI-team code
│   │   ├── ai-pipeline/
│   │   ├── sip/
│   │   ├── rag/
│   │   └── design-docs/
│   ├── landingPage.html   <- frontend team
│   └── login.html         <- frontend team
└── globifye-ai/           <- OLD standalone repo, now a local backup only
```

GitHub side (both repos hold the same content):

```
   local dial-forge/  ──push──▶  company : GlobiFYE-USA/dial-forge         (shared, team)
                      └─push──▶  origin  : shuyangzhang-ai-sde/globifye-ai (private mirror)
```

---

## 3. Daily workflow

Always work inside the clone:

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge
```

**Step 1. Pull the latest before starting.**
This brings down both AI and frontend changes.

```bash
git pull company main
```

**Step 2. Edit your code inside `dial-forge-ai/`.**
Do not touch `landingPage.html` / `login.html`; those belong to the frontend team.

**Step 3. Commit and push to both repos.**

```bash
git add -A
git commit -m "your message"
git push company main
```

Because `company` carries two push URLs, that single push updates both the shared repo and the personal mirror.

> **What's "push to both URLs":**
> A remote can have more than one push address. `company` is set to push to the shared repo first, then the personal repo. `git pull` still reads only from the shared repo, so pulling is unaffected.

**Verify both repos received the push:**

```bash
git fetch company && git fetch origin
git rev-parse company/main origin/main HEAD
```

Expected: all three hashes are identical.

---

## 4. Auth setup (why two GitHub accounts do not collide)

Two GitHub accounts are involved:

| Account | Used for | Repo |
|---------|----------|------|
| `shuyangzhang-globifye` (emma.zhang@globifye.com) | company repo access | GlobiFYE-USA/dial-forge |
| `shuyangzhang-ai-sde` (personal) | personal mirror | shuyangzhang-ai-sde/globifye-ai |

macOS Keychain stores one credential per (host, username) pair, so both tokens coexist. The trick that keeps them apart: the company remote URL carries its username inside it.

```
company  https://shuyangzhang-globifye@github.com/GlobiFYE-USA/dial-forge.git
origin   https://github.com/shuyangzhang-ai-sde/globifye-ai.git
```

When git pushes to `company`, it asks Keychain for the `shuyangzhang-globifye` token. When it pushes to `origin` (no username in the URL), it resolves to the personal account. Neither overwrites the other.

> **What's a Personal Access Token (PAT):**
> GitHub no longer accepts your login password over HTTPS. Each account needs a token (Settings, then Developer settings, then Tokens) with the `repo` scope. The token is entered once on the first push and cached in Keychain.

---

## 5. Troubleshooting (real errors hit during setup)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `remote: Repository not found` (404) on push | git authenticated as the wrong account (`shuyangzhang-ai-sde`), which has no access to the private `dial-forge` | Put the authorized username in the remote URL, push again, enter that account's PAT |
| `! [rejected] main -> main (fetch first)` | The remote already had commits (the frontend landing page) that the local repo did not have | Do not force-push. Merge the remote first, then push (see appendix) |
| `remote: This repository moved` | The personal repo was renamed on GitHub (`GlobiFYE-sde-ai`, now `globifye-ai`) | Update the remote URL to the new name with `git remote set-url` |

> **Why never force-push here:**
> The shared repo holds other people's work. `git push --force` overwrites remote history and would delete the frontend team's commits. Always merge or pull first, so the push is a fast-forward (a clean append onto existing history).

---

## Appendix: one-time setup commands (skip on first read)

How the current clone was built. Only needed to reproduce the setup on a new machine.

```bash
# 1. Clone the shared repo, with the authorized username baked into the URL
git clone https://shuyangzhang-globifye@github.com/GlobiFYE-USA/dial-forge.git dial-forge
cd dial-forge

# 2. Name the remotes: company = shared, origin = personal mirror
git remote rename origin company
git remote add origin https://github.com/shuyangzhang-ai-sde/globifye-ai.git

# 3. Make `git push company` push to BOTH repos
git remote set-url --add --push company https://shuyangzhang-globifye@github.com/GlobiFYE-USA/dial-forge.git
git remote set-url --add --push company https://github.com/shuyangzhang-ai-sde/globifye-ai.git

# 4. Set commit identity for company work (email attributes commits to the globifye account)
git config user.name  "Shuyang Zhang"
git config user.email "emma.zhang@globifye.com"

# 5. Environment files are gitignored (not in the repo). Copy them from the old folder:
#      dial-forge-ai/ai-pipeline/.env.local
#      dial-forge-ai/ai-pipeline/node_modules
#      dial-forge-ai/venv
#    Python dependency versions are recorded in dial-forge-ai/requirements.txt

# --- If a push is rejected with "fetch first" (remote has commits you lack) ---
git pull company main --allow-unrelated-histories --no-edit   # merge, do not force
git push company main
```
