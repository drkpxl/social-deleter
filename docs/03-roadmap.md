# Roadmap

## Phase 1 — Bluesky (the training ground)

Build the entire skeleton against the friendliest target:

- WXT + TypeScript project scaffold, side panel UI, thin service worker.
- `SiteAdapter` interface + Bluesky adapter (posts, replies, likes; date filter).
- Pacing engine, Stop handling, append-only deletion log + resume.
- LLM client (Ollama / LM Studio) with both fallback jobs wired in.
- **Validation gate:** intentionally break selectors in the map and confirm the LLM repairs them against the live site; kill the run mid-way and confirm resume from the log.

**Done when:** a full delete run (all three categories, date-filtered) completes on a test Bluesky account, survives a forced selector break, and resumes after a forced stop.

## Phase 2 — X

- Port the adapter; expect the real anti-bot friction here.
- Likes are an *unlike* action, not a delete — adapter handles the semantic difference.
- Reposts/quote-posts enumeration quirks; tighter pacing profile.
- Harden triage paths: rate-limit banners, "something went wrong" toasts, re-login walls.

**Done when:** a sustained multi-hour run on a real account completes without account flags, with backoff observed under rate limiting.

## Phase 3 — Threads

- Adapter port; expect Meta fingerprinting and aggressive lazy-loading DOM.
- Reuse everything from Phases 1–2; this phase should be mostly selector work.

**Done when:** parity with Phase 2 criteria on Threads.

## Distribution milestone (alongside Phase 1)

- Public GitHub repo, release ZIPs of the built extension.
- Illustrated README walkthrough for non-technical users (load-unpacked flow).

## Explicitly out of v1

- **Content-based delete/keep decisions via LLM** ("delete anything political") — a later phase; slower, token-heavy, and risks wrong deletions.
- **Rich filters** (keyword, engagement thresholds).
- **Dry-run / preview mode** — deliberately excluded by product decision (one-click start, Stop to halt).
- **Firefox port** — WXT keeps the door open; AMO unlisted signing is the path if it happens.
- **Full agentic driving** (LLM decides every click) — rejected as the base loop; deterministic-first stands.
