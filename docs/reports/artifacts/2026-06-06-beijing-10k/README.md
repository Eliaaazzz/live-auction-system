# Beijing 10k Evidence Artifacts - 2026-06-06

This directory contains a no-secret evidence bundle for the Beijing-near 10k
load investigation.

- `evidence-no-secrets.tar.gz`: compressed raw evidence from four production
  runs on the Beijing ECS.
- `evidence-no-secrets.tar.gz.sha256`: checksum for the bundle.

Included run directories:

- `evidence-locust-10k-20260606T134644Z`
- `evidence-wsload-10k-20260606T142007Z`
- `evidence-wsload-loopback80-10k-20260606T143148Z`
- `evidence-wsload-privateip-10k-20260606T144923Z`

Included artifact types:

- Locust raw logs, failures, stats CSV, stats history, and HTML report.
- Go `wsload` raw logs, summaries, shard summaries, gate outputs, and Replay
  Verifier logs.
- Server `/metrics` before/reset/clean/after JSON, selected hold-window metrics,
  and metrics sample windows.
- Host before/after snapshots (`uname`, `nproc`, `free`, `df`, `ss`, `ip addr`,
  network sysctl, top processes).

Excluded on purpose:

- Token files and token shard files.
- Runtime env files.
- Run wrapper scripts that may contain operator-only variables.
- SSH keys or any private key material.

Local sensitive scan before commit returned zero matches for canonical test
tokens, JWT-like strings, `Authorization`, `Bearer`, metrics reset headers,
private keys, `JWT_SECRET`, and `EVIDENCE_SIGN_KEY`.
