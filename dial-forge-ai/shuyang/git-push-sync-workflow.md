# GlobiFYE Git Push & Sync Workflow

**Author:** Shuyang Zhang (AI)
**Last updated:** 2026-07-17

**Goal of this doc:** Explain how the AI-team code lives inside the shared company repo (`dial-forge`), how to push to it, and how a private full mirror is kept in a personal GitHub repo. It reads as a from-scratch setup guide: do Section 3 once, then use the daily workflow in Section 4.

**Non-goals:** This is not about the app code itself (SIP, RAG, ai-pipeline). Nothing here changes how the code runs, only how it is version-controlled and shared.

**Repositories:**
- Company (shared, team): [github.com/GlobiFYE-USA/dial-forge](https://github.com/GlobiFYE-USA/dial-forge)
- Personal mirror (private backup): [github.com/shuyangzhang-ai-sde/globifye-ai](https://github.com/shuyangzhang-ai-sde/globifye-ai)

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

## 2. What you are building (the layout)

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

## 3. One-time setup (do these once, in order)

Run these the first time on a machine. Each step happens once; after this, only Section 4 is needed.

### Step 1. Get a Personal Access Token for the company account

Sign in to GitHub as **`shuyangzhang-globifye`** (the account that has access to `dial-forge`), then:

1. Settings, then Developer settings, then Personal access tokens, then Tokens (classic)
2. Generate new token (classic), tick the **`repo`** scope
3. Generate, and copy the token (it is shown only once)

> **What's a Personal Access Token (PAT):**
> GitHub no longer accepts your login password over HTTPS. A token with the `repo` scope stands in for the password. You paste it once at the first clone/push, and macOS Keychain caches it after that.

> **Why the company account, not the personal one:**
> Only `shuyangzhang-globifye` is a member of the GlobiFYE-USA org and can reach the private `dial-forge`. The personal account `shuyangzhang-ai-sde` gets a 404 "not found" on it (see Troubleshooting).

### Step 2. Clone the shared repo (username baked into the URL)

```bash
cd /Users/shuyangzhang/GlobiFYE
git clone https://shuyangzhang-globifye@github.com/GlobiFYE-USA/dial-forge.git dial-forge
cd dial-forge
```

Git prompts for a password on the first clone: paste the token from Step 1.

> **Why put the username in the URL:**
> It tells git (and Keychain) to use the `shuyangzhang-globifye` token for this repo, so it never collides with the personal account's token stored for the same host.

### Step 3. Name the two remotes

```bash
git remote rename origin company          # the clone's default remote becomes "company"
git remote add origin https://github.com/shuyangzhang-ai-sde/globifye-ai.git
```

- `company` = shared team repo (dial-forge)
- `origin` = personal private mirror (globifye-ai)

### Step 4. Make `git push company` push to BOTH repos

```bash
git remote set-url --add --push company https://shuyangzhang-globifye@github.com/GlobiFYE-USA/dial-forge.git
git remote set-url --add --push company https://github.com/shuyangzhang-ai-sde/globifye-ai.git
```

Verify (expect one fetch address, two push addresses):

```bash
git remote get-url company               # 1 fetch address  (company only)
git remote get-url --push --all company  # 2 push addresses  (company + personal)
```

> **What this gives you:**
> A remote's fetch address and push address are separate. `company` now fetches from one place (the shared repo) but pushes to two (shared + personal). That is the "pull from one place, push to both places" rule.

### Step 5. Set the commit identity

```bash
git config user.name  "Shuyang Zhang"
git config user.email "emma.zhang@globifye.com"
```

The email is what attributes commits to the globifye GitHub account. This is a local setting, so it only affects this repo.

### Step 6. Copy the environment files from the old folder

These are gitignored, so they are not in the repo and must be brought over by hand into `dial-forge/dial-forge-ai/`:

| File / folder | Note |
|---------------|------|
| `ai-pipeline/.env.local` | Secrets. Cannot be regenerated, must be copied. |
| `ai-pipeline/node_modules` | Copy it, or run `npm install` inside `ai-pipeline/`. |
| `venv` | Copy it, or rebuild with `python3 -m venv venv` + `pip install -r requirements.txt`. |

Setup is done. From here on, only the daily workflow below is needed.

---

## 4. Daily workflow

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

**Step 3. Commit and push to both repos.**

```bash
git add -A
git commit -m "your message"
git push company main
```

Because `company` carries two push URLs, that single push updates both the **company repo** and the **personal repo**.

> **What's "push to both URLs":**
> A remote can have more than one push address. `company` is set to push to the shared repo first, then the personal repo. `git pull` still reads only from the shared repo, so pulling is unaffected.

**Verify both repos received the push:**

```bash
git fetch company && git fetch origin
git rev-parse company/main origin/main HEAD
```

Expected: all three hashes are identical.

---

## 5. How auth works (reference)

Two GitHub accounts are involved:

| Account | Used for | Repo |
|---------|----------|------|
| `shuyangzhang-globifye` (emma.zhang@globifye.com) | company repo access | GlobiFYE-USA/dial-forge |
| `shuyangzhang-ai-sde` (personal) | personal mirror | shuyangzhang-ai-sde/globifye-ai |

macOS Keychain stores one credential per (host, username) pair, so both tokens coexist. The trick that keeps them apart is Step 2's username-in-the-URL:

```
company  https://shuyangzhang-globifye@github.com/GlobiFYE-USA/dial-forge.git
origin   https://github.com/shuyangzhang-ai-sde/globifye-ai.git
```

When git pushes to `company`, it asks Keychain for the `shuyangzhang-globifye` token. When it pushes to `origin` (no username in the URL), it resolves to the personal account. Neither overwrites the other.

---

## 6. Troubleshooting (real errors hit during setup)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `remote: Repository not found` (404) on push | git authenticated as the wrong account (`shuyangzhang-ai-sde`), which has no access to the private `dial-forge` | Put the authorized username in the remote URL (Step 2), push again, enter that account's PAT |
| `! [rejected] main -> main (fetch first)` | The remote already had commits (the frontend landing page) that the local repo did not have | Do not force-push. Merge the remote first, then push (see below) |
| `remote: This repository moved` | The personal repo was renamed on GitHub (`GlobiFYE-sde-ai`, now `globifye-ai`) | Update the remote URL to the new name with `git remote set-url` |

**If a push is rejected with "fetch first"** (the remote has commits you lack):

```bash
git pull company main --allow-unrelated-histories --no-edit   # merge, do not force
git push company main
```

> **Why never force-push here:**
> The shared repo holds other people's work. `git push --force` overwrites remote history and would delete the frontend team's commits. Always merge or pull first, so the push is a fast-forward (a clean append onto existing history).
