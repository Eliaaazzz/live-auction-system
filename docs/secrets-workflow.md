# Secrets Workflow

Draft for PDGGK and Eliaaazzz review.

`docs/decisions.md` Q7 is the governing rule for Doubao credentials: "Secrets never enter git, issue, PR, commit, log, or screenshot. Repo keeps only `.env.example`; local and deploy credentials stay in private channels / GitHub Secrets. AI Sidecar must degrade to mock, timeout fallback, and never block bidding." Operational shorthand: **never into git, issues, PRs, commits, logs, or screenshots; the AI Sidecar can degrade**.

Local development uses `.env` copied from `.env.example`. The real `DOUBAO_API_KEY` is filled only on a developer machine. The repository should ignore `.env` before anyone stores local credentials; if the root `.gitignore` is absent, PDGGK should decide when to create it and include `.env`.

CI and deployment must read credentials from GitHub Secrets, not from committed files. Expected secret names are `DOUBAO_API_KEY`, `DOUBAO_ENDPOINT_ID`, `MYSQL_URL`, `REDIS_URL`, and `JWT_SECRET`, with environment-specific values configured outside the repository.

The shared Doubao API key is distributed privately between teammates only. It must not appear in GitHub issues, pull requests, commits, terminal logs, application logs, screenshots, recordings, or provider-console captures.

AI Sidecar degradation follows Q7:

| Condition | Behavior |
|---|---|
| No key | Use mock AI output. |
| Timeout | Return fallback copy. |
| AI exception | Preserve the bidding path and report a non-blocking AI failure. |
