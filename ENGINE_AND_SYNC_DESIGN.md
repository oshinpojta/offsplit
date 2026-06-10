# Offsplit — Engine & Sync Design Resolutions

> Companion to [`BUILD_SPEC.md`](./BUILD_SPEC.md). Resolves every known ambiguity in the two riskiest modules — the **merge engine + money math** (Sprint 1) and **offline sync** (Sprint 6) — *before* implementation. Each decision has an ID (M-x, S-x, X-x); tests and code reference these IDs. If a decision changes, change it here first, then in the golden vectors, then in code.

---

## Part A — Merge engine + money math

### A0. The load-bearing insight: **a merge writes exactly one row**

The entire §6 invariant set (R1–R7) collapses into something simple and provable if the merge operation mutates **only user B's row**:

```sql
UPDATE users SET status='merged', merged_into=:A, updated_at=:now WHERE id=:B;
INSERT INTO merge_records (...);   -- audit snapshot
```

**Nothing else is ever written** — not `expense_splits`, not `settlements`, and (going beyond the spec's letter) **not `group_members` either**. All identity — balances, membership lists, settlement parties — resolves at **read time** through `effectiveUserId()`.

Consequences (these are why the design is correct, not just convenient):

- **Reversal (R5/T3) is trivially exact.** Reverse = restore B's `status`/`merged_into`. Since no other row changed, all balances return to *exactly* the pre-merge state by construction — T3 stops being a hard test and becomes a sanity check.
- **Third-party invariance (R3/T1) is provable.** C's net = Σ(C's paid amounts) − Σ(C's split rows). None of those rows were touched, so C's net is unchanged. Only the *direction labels* on the simplified transfer graph change (C now pays A instead of B) — C's number cannot move.
- **Self-debt (R7) needs no special-casing in the engine.** Net balance aggregates by *effective* user, so A-owes-B legs cancel arithmetically when both resolve to the same survivor. The only explicit rule: the pairwise/"raw" view filters pairs where `effective(from) == effective(to)`.
- **Offline writes racing a merge stay correct.** A device that was offline during the merge window may still create an expense referencing B. That row is stored as written and *resolves* to A while merged — and back to B if the merge is reversed. In the claim case that is semantically right: reversal means "the claim was wrong," so debts pointing back at ghost B is the correct outcome. No fix-up pass needed, ever.

### A1. Merge decisions

| ID | Decision | Rationale / notes |
|---|---|---|
| **M1** | **Merge executes only on the server** — online-only, atomic (D1 transaction), serialized. Clients never perform a merge locally; they learn about it via sync and re-resolve. | Merge touches global identity across groups and devices; it cannot be an offline mutation. The claim flow is online by nature (token redemption + sign-in), so this costs nothing. |
| **M2** | Merge mutates **only** `users.B` (+ `merge_records` audit row). No rewrites of splits, settlements, **or `group_members`** — membership also resolves at read time. | See A0. Member lists dedupe after resolution (if A and B were both in a group, the UI shows A once). |
| **M3** | **Resolution-first:** before merging, resolve both ids to live survivors (`A := effective(A)`, `B := effective(B)`). If they're now equal → **idempotent no-op success** (R6/T4). Merging *into* a tombstone follows the chain (T5). | Under M1 serialization + resolution-first, a cycle cannot form; `effectiveUserId` still asserts on cycles as a tripwire. |
| **M4** | **Read-time resolution everywhere.** Every balance, membership, settlement, and simplification read passes user ids through `effectiveUserId()`. No read path may bypass it. | This is §5.2 made into a hard layering rule: raw rows are storage; effective identity is a view. |
| **M5** | On merge, the **survivor's profile wins** (`display_name`, `default_upi_id`). B's VPA is preserved in the snapshot and offered as a suggestion if A has none. | Avoids silently swapping someone's payout VPA. |
| **M6** | **Auth resolves to the survivor.** Sign-in looks up `google_sub` → user → `effectiveUserId` → session is issued for the survivor. A tombstoned B's Google account therefore controls A (correct for link-duplicate, where the user proved both). Reversal restores separation. | `google_sub` stays UNIQUE on the tombstoned row; never null it out — it's what makes reversal clean. |

### A2. Money-math decisions

| ID | Decision | Rationale / notes |
|---|---|---|
| **M7** | **Integer paise everywhere.** `Σ(share_amount) == amount_total` is enforced at the engine boundary **and** as a check before every DB write. Floats never enter the engine — not even transiently. | §15.4. UPI `am=` conversion to rupees-2dp happens at the very edge (link builder), nowhere else. |
| **M8** | **One deterministic rounding rule: largest-remainder, ties broken by `user_id` ascending.** Specifically: **equal** → `floor(total/n)` each, first `r = total − n·floor` participants by `user_id` asc get +1 paise. **percent** → percentages are integer **basis points** summing to 10000; `floor(total·bp/10000)` + largest-remainder distribution. **shares** → integer weights; `floor(total·w/W)` + largest-remainder. **exact** → must sum exactly or **reject** (no auto-fix). | The spec offered options ("to the payer, or first-N") — we pick one, language-neutral rule so Dart and TS cannot diverge. Not "to the payer": the payer isn't necessarily a participant. Percentages as basis points kills float input at the API boundary too. |
| **M9** | **Balances are keyed `(group_id, currency, effective_user_id)` from day one**, even though Phase 1 is INR-only. | Phase-2 multi-currency then adds rows, not a migration of the engine's core type. |
| **M10** | **Settlements affect balances at `marked_paid`** (and stay applied through `confirmed`); a `disputed` transition un-applies them (back to `pending`). | The spec's §7.2 "apply confirmed settlements" read literally would leave a payer who just paid still showing as owing — confusing and a double-payment risk. Payer's own action updates their ledger immediately; the dispute path protects the payee. This matches the Splitwise mental model users already have. |
| **M11** | **Debt simplification is a pure, deterministic function** over net balances: greedy min-cash-flow, ordering by `(amount desc, user_id asc)`, output ≤ n−1 transfers. The raw "who you spent with" view is always computed and shown alongside (§7.3). | Determinism = suggested transfers never flicker between recomputes or between client/server. |

---

## Part B — Offline sync

### B0. The architecture: **an ordered mutation log, with the server as the only clock**

Sync is *not* state replication. It is:

```
client outbox (typed, ordered mutations, client UUIDs)
        │  POST /sync  (batched)
        ▼
server arbiter — applies in arrival order, one transaction per mutation,
        assigns per-entity `version` + global `seq`, dedups on client_mutation_id
        │
        ▼
global change feed (seq-ordered) — every device pulls from its cursor and reconciles
```

The client applies its own mutations to drift **optimistically** the moment the user acts; the server's feed is the truth that reconciliation converges to.

Two places where naive "everything is LWW" would corrupt the ledger are called out below (S4, S5) — they are the most important sync decisions in this document.

### B1. Sync decisions

| ID | Decision | Rationale / notes |
|---|---|---|
| **S1** | **Closed mutation vocabulary.** Envelope: `{client_mutation_id (UUIDv4), device_id, type, payload, client_ts}`. Types are an enum (`create_group`, `add_member`, `create_ghost`, `create_expense`, `update_expense`, `delete_expense`, `create_settlement`, `settlement_transition`, `update_profile`, …) — no generic "patch table X" mutation. | Every type gets explicit validation + authz; the vocabulary *is* the API contract for offline writes. |
| **S2** | **The server is the only clock.** Per-entity integer `version` and global `seq` are server-assigned. LWW = server **arrival order** — never client wall-clocks (skew) and never `updated_at` ties. `client_ts`/`txn_date` are display-only. | Deterministic §15.3 two-device resolution falls out of arrival order. |
| **S3** | **Batches are ordered but NOT atomic.** Each mutation applies in its own transaction; the response is a per-mutation result array: `applied` \| `duplicate` \| `rejected(reason)`. Client deletes acked outbox rows immediately; `rejected` rows are dropped from the outbox and surfaced to the user (never retried forever, never silently discarded). | One invalid mutation must not wedge the whole outbox behind it. Duplicates (replays) are recognized via `applied_mutations` (§10.1). |
| **S4** | **The edit unit for an expense is the whole document: expense row + complete splits array.** `update_expense` always carries full splits; the engine validates `Σ == total` atomically on every apply. There is **no field-level or split-row-level merging.** | Field-merging two offline edits of the same expense could produce a split set that sums wrong — the exact silent-corruption class this app must never have. Whole-document LWW keeps every applied state internally consistent. |
| **S5** | **Settlement status is NOT LWW — it's a guarded state machine.** A `settlement_transition` mutation applies only if legal from the *current server state* (§8.2); otherwise it's `rejected(stale_transition)`. | Blind LWW would let a stale offline `mark_paid` arrive after `confirmed` and regress the state. Money-state transitions must be monotone per the state machine, not last-writer-wins. |
| **S6** | **Tombstones are terminal.** An edit arriving after a soft delete is `rejected` — deleted entities never resurrect (§15.3). (An explicit `restore` mutation can be added later if the product wants undelete.) | |
| **S7** | **Pull = cursor + membership-aware feed + snapshot-on-join.** Client sends its last `seq`; server returns (a) all changes with `seq > cursor` for groups where the user is an (effective) member, (b) all referenced `users` rows, and (c) a **full snapshot** of any group the user became visible in since the cursor. New cursor returned. | Snapshot-on-join solves the "added to an existing group with 200 expenses" cold-start without special client logic. |
| **S8** | **Merges propagate as ordinary user-row changes** in the feed. On receiving one, the client re-resolves identity locally (same `effectiveUserId` logic over its drift `users` table) and **invalidates the materialized balance caches** for affected groups. | No special "merge event" needed in the protocol; the user row *is* the event. |
| **S9** | **Optimistic local apply + truth-repair.** Client applies its mutation locally at once; if the server later rejects it, the client re-pulls that entity's authoritative state and surfaces the rejection in an activity/"needs attention" feed. The server keeps the **append-only edit log** (§10.2), so LWW "losers" remain auditable and recoverable. | "The app ate my correction" is answerable from the log, by support or a future history UI. |
| **S10** | **Operational bounds:** batch caps (≤100 mutations / ≤1 MB), single-flight sync (mutex — never two concurrent `/sync` calls per device), exponential backoff, `applied_mutations` pruned at 90 days (safe: acked outbox rows are deleted immediately, so replays only occur within short windows). **Authz per mutation** — membership checked on every group-scoped write; member-removal guarded by non-zero balance (§11). | |

---

## Part C — The dual-implementation problem & golden vectors

The engine necessarily exists **twice**: TypeScript (Workers — authoritative `/sync` validation, `/balances`) and Dart (client — offline balances must work in airplane mode). Two implementations of money math *will* drift unless something forces them not to.

| ID | Decision |
|---|---|
| **X1** | **A language-neutral golden test-vector suite is the single source of truth for engine behavior.** JSON fixtures in `offsplit/engine-vectors/`, each case = `{name, given: {users, expenses, settlements, merges…}, when: <operation>, expect: {splits / balances / transfers / status / error}}`. **Both** the TS and Dart test suites load and run the *same files*. CI runs both on every PR. Any behavioral change starts as a vector change, then both implementations are updated until green. |
| **X2** | **Rejected alternatives:** running the TS engine in the client via `flutter_js` (a JS-bridge hop on every balance render — perf + complexity + debugging pain); server-only balance computation (breaks the offline-first core requirement §2.4); Rust/FFI shared core (overkill for ~1k lines of pure functions). |

**Vector coverage (supersedes §15.1/§15.4 as the concrete checklist):**

1. **Money math** — every split type × rounding remainders (incl. 1-paise totals, n > total edge), Σ==total invariant, 1000+ randomized no-float-drift property cases (property test seeds fixed for reproducibility).
2. **Simplification** — determinism (same input → same transfers), ≤ n−1, raw-vs-simplified consistency.
3. **Merge matrix T1–T7** — expressed as `state → merge(B,A) → expected`, plus: **T8** merge-then-reverse-then-re-merge; **T9** offline expense referencing B created during merge window (resolves to A; after reversal resolves to B); **T10** A and B co-members of the same group (member list dedupes; self-debt filtered).
4. **Settlement state machine** — every legal and illegal transition (§15.2), including **stale offline transitions** (S5 rejection cases) and balance effect timing (M10: applied at marked_paid, reverted on dispute).
5. **Sync semantics** — replay-once (duplicate detection), two-device LWW arrival-order determinism, edit-after-delete rejection, whole-document expense edit (S4), snapshot-on-join shape.

---

## Part D — Robustness architecture (defense in depth)

Parts A–C define *correct behavior*. Part D defines how the system **stays** correct when code has bugs, requests race, devices crash mid-sync, and tokens leak. Robustness here = five independent layers; a defect must get through all five before it silently corrupts anyone's money.

```
L1  Validate    — pure-function engine rejects bad input at the boundary
L2  Enforce     — transactional re-assertion + CAS at every write
L3  Constrain   — schema-level guards (CHECK, FK, UNIQUE) as the last write barrier
L4  Reconcile   — continuous auditing + production cross-checking detects what slipped through
L5  Recover     — resync, cache rebuild, merge reversal, point-in-time restore
```

### D1. Merge concurrency — how serialization actually works on D1

D1 is SQLite: **one writer per database, writes serialize**. We exploit that instead of building locks:

- The merge runs as a **single D1 transaction** that (1) re-resolves `A := effective(A)`, `B := effective(B)` *inside* the transaction, (2) validates both are `active`, (3) executes the CAS write `UPDATE users SET status='merged', merged_into=:A WHERE id=:B AND status='active'`, (4) walks the chain as a cycle assert, (5) commits. `rows_affected = 0` → someone merged first → re-resolve → idempotent no-op.
- **Every race is covered by this one pattern:**
  - *Double-claim of one ghost* — CAS on `claim_tokens` (`WHERE claimed_by IS NULL AND expires_at > :now`): exactly one wins.
  - *Merge vs merge* — serialized by SQLite; the loser's CAS hits 0 rows.
  - *A→B racing B→A* — second transaction re-resolves, finds its target tombstoned, follows the chain, arrives at survivor→survivor = no-op. **Cycles cannot form** under in-transaction resolution + single-writer; the walk-chain assert is a tripwire, not the mechanism.
  - *Merge vs reversal* — reversal is also CAS: `WHERE id=:B AND status='merged' AND merged_into=:A AND reversed_at IS NULL AND reversible_until > :now` (paired with the `merge_records` row).
- **Reversal is always ledger-safe** (consequence of A0 — no rows were rewritten), so a reversal after real-world money moved is a *UX* event, not corruption: affected groups get an activity-feed notice that balances re-resolved.

### D2. Money-math hardening

- **Bounds before math:** `amount_total` ∈ [1, 10¹²] paise (₹100 crore cap — overflow headroom *and* fat-finger guard; JS safe-integer limit is 2⁵³ ≈ 9×10¹⁵), participants per expense ≤ 50, group members ≤ 200, weights/basis-points integer and bounded. Non-integer percent/weights are rejected at the API, never coerced.
- **Schema as the last barrier (L3):** `CHECK (amount_total > 0)`, `CHECK (share_amount >= 0)` (zero shares are legal — equal split of 3 paise across 5 people), status columns CHECK-constrained to their enums, FKs ON.
- **Per-write re-assertion (L2):** every transaction that writes an expense re-verifies `Σ(splits) == amount_total` against what's actually being committed — even though the engine already validated it. Cheap insurance against a future code path that forgets to call the engine.

### D3. Claim-token hardening

- ≥128-bit URL-safe random tokens; **GET never mutates** — the claim landing page is pure read, so WhatsApp/Telegram link-preview crawlers can't burn tokens. Claiming requires an authenticated POST.
- Single-use via CAS (D1); TTL ~7 days with one-tap re-mint; bind-on-first-authenticated-open (already M-series); per-IP and per-account rate limits on claim attempts; generic error responses (no valid/expired/claimed oracle for enumeration); every attempt audit-logged; tokens revocable.

### D4. Sync durability mechanics

- **Atomic intent capture — the linchpin:** the user's local write and its outbox entry commit in **one drift transaction**. A crash can never produce a local change that won't sync, or an outbox entry for a change that didn't happen.
- **Ack discipline:** outbox rows are deleted only on server `applied`/`duplicate`; `rejected` rows move to a local "needs attention" store. Exactly-once = at-least-once retry + server-side dedup (`applied_mutations`) — a crash between server-apply and client-ack just replays into a `duplicate`.
- **Dependency handling:** outbox is strict FIFO per device; a mutation whose referenced entities don't exist (and weren't created earlier in the same batch) is rejected `missing_dependency`, and its dependents cascade-reject — surfaced as *one* user-visible error, never silently skipped or reordered around.
- Single-flight sync mutex; exponential backoff; batch caps (≤100 mutations / ≤1 MB); envelope carries `schema_version` — server supports N−1 and the house-style force-update gate handles older clients.

### D5. Resync & recovery paths (L5)

- `change_log` retained ~90 days. A client whose cursor predates retention gets `resync_required`: it rebuilds all group state from snapshots **while preserving its unsynced outbox**, then re-pushes. (Test case: resync with pending outbox.)
- Materialized balance caches are **versioned by `seq`**; any mismatch (or any doubt) triggers an idempotent per-group rebuild from raw rows — the cache is never trusted, only used.
- Ops: D1 Time Travel (30-day PITR) enabled + periodic export to R2 for longer-horizon archive. ⚙️

### D6. The invariant auditor (L4 — the safety net for everything above)

A scheduled Worker (cron) sweeps groups (full nightly at small scale, sampled later) and verifies the **books balance**:

1. Per group, per currency: `Σ(net balances) == 0` — the double-entry identity.
2. Every non-deleted expense: `Σ(splits) == amount_total`.
3. Every settlement status reachable via legal transitions; no orphan splits; no merge chains that cycle or exceed sane depth.
4. Sampled: materialized cache == fresh recompute.

Any violation → Sentry alert (target rate: **zero**) + the group flagged for admin tooling. The client runs the same mini-audit on group open (recompute vs cache; mismatch → silent rebuild + telemetry). The auditor is what turns "we tested it well" into "we *know* production is consistent, continuously."

### D7. Production divergence detection — free differential testing

`/sync` already returns authoritative server rows after applying mutations. The client compares them against its optimistic local computation. Any mismatch is a **silent telemetry event** (entity ids + field-diff flags — no amounts) and the case gets minimized into a new golden vector. Effect: the Dart and TS engines continuously cross-check each other on real-world data, forever — divergence is detected in hours, not when a user notices a wrong balance.

### D8. Simulation & fuzz testing (pre-ship counterpart of D7)

- **Sync simulation suite (TS, fast-check):** N virtual devices generate random mutation streams under random partitions, reorderings, replays, and crash-points; after the storm, assert **convergence** (all devices reach identical state) and **all invariants** (D6's list). Fixed seeds in CI; any failing seed is shrunk and promoted to a named golden vector.
- **Money-math property tests (both languages):** 1000+ randomized expenses → no drift, splits always sum, simplification conserves (suggested transfers settle the nets *exactly*, ≤ n−1).

### D9. Observability & guardrails

Day-one metrics (PostHog/Sentry): mutation reject-rate by reason, duplicate rate, resync rate, sync apply latency, D1 write latency, auditor violations, D7 mismatches. Alerts: **any** auditor violation or D7 mismatch (these are "stop and look" signals), reject-rate spikes (leading indicator of a bad client release).

---

## What this means for the sprint plan

- **Sprint 1** builds: `engine-vectors/` (first), then the TS engine package (`workers/packages/engine`), then the Dart mirror (`app/lib/engine/`), both green against the same vectors — **plus the D2 bounds and D8 money-math property tests.** *No DB adapters, no UI, no network in this sprint.*
- **Sprint 5** carries the D1 CAS/transaction patterns (merge + claim writes), D2 schema CHECKs, and D3 token hardening.
- **Sprint 6** builds the mutation-log machinery (S1–S10) + **D4 atomic outbox, D5 resync path, D8 simulation suite, and the D6 invariant auditor cron** — the *semantics* are already fixed here, so Sprint 6 is plumbing + verification, not design work.
- **Sprint 8 (launch)** must have **D7 mismatch telemetry and D9 metrics/alerts live** — they are launch blockers, not polish: they're how engine divergence in the wild gets caught in hours instead of via a user's wrong balance.
- Decisions **M10** (settlement balance timing), **S4** (expense-as-document), and **S5** (settlements not LWW) are *deliberate refinements* of a literal spec reading — if any of them is overturned later, vectors change first.
