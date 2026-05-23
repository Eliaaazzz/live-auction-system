# Lumen Auction diagrams v4

These diagrams are generated from the current GitHub/spec contract pass:

- official challenge spec in `docs/spec/`
- GitHub issues `#1` to `#17`
- pull requests `#12`, `#13`, `#16`, `#18`, `#19`, `#20`
- implementation contracts from `origin/elia/T1-dummy-bid-roundtrip`

The `../gpt-image-2-drafts/` directory keeps the raw GPT image 2 outputs as drafts.
Those drafts were inspected, but they are not the upload source of truth because
technical text and arrow direction must be exact for GitHub review.

The final upload candidates in this directory are the checked `*.png` and `*.svg`
files. Diagrams 01-03 are hand-authored SVG diagrams derived from the existing
v3 checked layout and updated for this pass. Diagrams 04-08 are Mermaid-authored
and rendered to both SVG and PNG.

## Final diagram set

1. `01-system-architecture`
2. `02-bid-hot-path`
3. `03-auction-state-machine`
4. `04-reconnect-catchup`
5. `05-timer-evidence`
6. `06-mysql-er`
7. `07-ai-sidecar`
8. `08-ownership-evidence`

See `inspection-report.md` for the per-image acceptance notes.

## Canonical / Deprecated

**v4 is the canonical architecture diagram set** for issues, PR review, mentor sync, and answer-deck materials going forward.

Older sets under `docs/architecture/` top level are **deprecated**:

- `live_auction_*_v2_overwrite.svg` and `*_v3.svg` (Eliaaazzz, pre-V9 single-source closure) — kept for diff history only
- A separate cleanup PR will remove deprecated versions after v4 merges; meanwhile reviewers should reference v4 PNGs

The `../gpt-image-2-drafts/` directory is **visual reference only** (raw GPT image 2 outputs). It is **not** a canonical source — text/arrow accuracy was not validated. `03-state-machine-draft-rejected.png` is explicitly rejected. Future agents must not treat any draft as authoritative.
