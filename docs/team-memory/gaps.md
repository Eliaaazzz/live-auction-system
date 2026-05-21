# Gaps

This file tracks differences between the PDF, V8, RFC v1, and current planning notes. Do not use it to reopen V8 casually; use it to keep scoring and delivery risks visible.

## V8 vs PDF / RFC Findings

1. **Deadline mismatch.** PDF says challenge work ends 2026-06-10 and demos run 2026-06-11 to 2026-06-12. V8 says 2026-06-08. Treat 06-08 as internal freeze and 06-10 as external deadline.
   **Status (5.21)**: RESOLVED — Eliaaazzz set external 2026-06-10 and internal 2026-06-08.

2. **Name split.** PDF title is “实时竞拍大师”, V8 uses “Lumen Auction”, README uses “直播竞拍系统”. This is a 10% materials clarity risk unless public docs consistently say `Lumen Auction` is the project name and “实时竞拍大师” is the challenge title.
   **Status (5.21)**: RESOLVED — project name is `Lumen Auction：直播实时竞拍系统`.

3. **Concurrency proof tension.** V8 P0 is 500 connected + 50 active bidders; PDF’s bonus language highlights 1000+ users. Preserve V8 P0, but keep 1k + 100 active as a visible Stretch target so the demo does not look under-ambitious.
   **Status (5.21)**: RESOLVED — 500/50 is P0 and 1000/100 is Stretch; this is not a binary tradeoff.

4. **Order/mock-pay visibility gap.** PDF asks for order management, result viewing, simulated payment, and history. V8 foregrounds evidence card and Replay Verifier. The product plan must still show order creation and mock payment enough to satisfy the 50% full-chain score.
   **Status (5.21)**: OPEN — B-line owner should acknowledge and follow up on order/history/mock-pay visibility.

5. **AI scoring artifact gap.** PDF’s 15% AI score asks for AI tool workflow, process traceability, and code contribution reasonableness. Runtime VLM/LLM features alone do not satisfy that. The team needs an AI usage log/report path, not just an AI bubble in the room.
   **Status (5.21)**: OPEN — C-line owner should follow up with AI usage log/materials.

6. **Technical-depth sink risk.** Replay Verifier, hash chain, and five failure videos are strong, but could consume time without directly improving PDF-visible flow. Preserve them, but timebox and map each to scoring evidence: consistency, auditability, or stability.
   **Status (5.21)**: RESOLVED — Eliaaazzz explicitly put Replay Verifier in P0.

7. **Failure-video tracking conflict.** V8 says Issue #9 adds five fault-drill videos, but Issue #9 mainly lists a 180-second demo and fallback checklist. Keep the V8 requirement, but do not claim Issue #9 alone proves it.
   **Status (5.21)**: RESOLVED — five fault-drill short videos are part of P0.

8. **State vocabulary conflict.** V8 uses `Bidding/Hammered/Passed/ReserveNotMet/Settled`; RFC v1 uses `LIVE/SOLD/NO_BID/ORDER_CREATED`; Issue #4 says start moves to `Bidding`. Public docs should use V8 names and mention RFC aliases only during migration.
   **Status (5.21)**: RESOLVED — `docs/state-machine.md` is the single state-machine contract.

9. **Closed issue ambiguity.** Issues #3-#9 are marked closed but acceptance checkboxes remain unchecked. Treat them as planning records, not proof that implementation work is done.
   **Status (5.21)**: RESOLVED — #3-#9 are design references, not active Sprint 1 entry points.

10. **`proto/` directory assumption.** Eliaaazzz’s #11 contract plan assumes an existing `proto/` directory, but the current repo does not contain it.
   **Status (5.21)**: OPEN — A-line owner should establish `proto/` before B/C depend on contract files.

## Q1-Q9 Tracking

| Q | Item | Current tracking |
|---|---|---|
| Q1 | Deadline | RESOLVED: external 06-10, internal freeze 06-08. |
| Q2 | Project name | RESOLVED: use `Lumen Auction：直播实时竞拍系统`; keep “实时竞拍大师” as challenge name. |
| Q3 | A/B/C ownership | PARTIAL: @Eliaaazzz confirms A; B/C remain TBD pending PDGGK and third-member confirmation. |
| Q4 | P0 highlight | RESOLVED: Replay Verifier/hash chain/500-50/five fault videos are P0; 1000/100 remains Stretch. |
| Q5 | PDGGK time | OPEN: PDGGK still needs to confirm actual availability. |
| Q6 | Third member | OPEN: third member still needs to self-introduce and pick B/C direction. |
| Q7 | AI account | PENDING CONFIRM: never copy secrets into docs; `.env.example`, local `.env`, deploy secrets, and private sharing only. |
| Q8 | Load target | RESOLVED: P0 500/50; Stretch 1000/100; metrics must include latency, seq gap, reconnect, bottlenecks, and recovery. |
| Q9 | Demo form | RESOLVED: public deployment + local Docker fallback + pre-recorded video insurance. |
