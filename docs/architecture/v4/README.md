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
