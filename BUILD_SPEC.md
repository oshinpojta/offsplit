# Bill-Splitter — Build Specification (handoff for Claude Code)

> Working codename: **Tally** (name is an open decision — see §16). A Splitwise alternative for India whose wedge is one-tap UPI settlement on a generous, no-paywall free tier.

---

## 0. How to use this document

- **Build phase by phase (§14). Do not attempt the whole app in one pass.** Phase 1 is a shippable product on its own.
- **The merge engine (§6) is the single riskiest module in the codebase.** It is the one place where a bug silently corrupts other people's money records. Build it **test-first**: implement the test matrix in §15.1 before the engine itself.
- Treat every rule written as **MUST** in §2 and §6 as a hard invariant, not a preference.
- This app **never processes payments**. If you ever find yourself writing code that holds, routes, or confirms a payment via an API, stop — that is out of scope and out of compliance (§16).

---

## 1. Product summary

A mobile bill-splitting app. Users create groups, log shared expenses, see who owes whom, and settle up by launching a pre-filled UPI payment in their own payment app (GPay / PhonePe / Paytm). The app is a **ledger + a launchpad**, never a payment processor.

**Why it can win:** Splitwise is alienating Indian users with expense caps and a paywall, and has zero UPI integration. We give away unlimited splitting for free and make settlement one tap. Frictionless onboarding (ghost members), debt simplification, trip mode, and a household/partner link are the differentiation.

**Target user:** Indian flatmates, friend groups, couples, and travel groups.

---

## 2. Non-negotiable principles (constraints)

1. **MUST NOT touch money.** No payment rails, no escrow, no holding funds, no PSP/payment-aggregator integration. Settlement is a UPI deep link the payer approves in their own app.
2. **MUST use UPI intent/deep links, never "collect" requests.** NPCI is phasing out P2P collect/request-money flows. Build only the intent model (§8).
3. **Settlement confirmation is manual.** There is no payment callback. The app tracks settlement state via explicit user action (§8.2).
4. **Thin backend, local-first client.** The client works fully offline against a local DB; the server handles sync, identity, and notifications only (§4, §10).
5. **MUST freeze history on merge.** Merging identities never rewrites historical expense splits (§6.3). Identity resolution happens at read time.
6. **Generous, no-paywall free tier.** Unlimited groups, expenses, and trips are free forever. This is the growth strategy. Monetization is ads-primary (§13).
7. **No OCR, no SMS, no phone auth.** (Removed from scope — auth is Google sign-in; §12.)

---

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Mobile | Flutter | Android first; iOS later (Apple Sign-In is a Phase-2+ add) |
| Local DB | drift (SQLite) | Source of truth on-device; offline-first |
| Auth | Firebase Auth — Google Sign-In | Free, one-tap on Android; no SMS cost |
| Backend | Cloudflare Workers | REST API; verifies Firebase ID tokens at the edge |
| Ledger DB | Cloudflare D1 (SQLite) | Default. Use Durable-Objects-per-group only if concurrent group edits get heavy (§10.3) |
| Push | Firebase Cloud Messaging (FCM) | Settlement nudges; free |
| Ads | Google AdMob | Revenue engine (§13) |
| Subscriptions | RevenueCat | Phase 3 only |

**Explicitly NOT in the stack:** R2 (no receipt images), any OCR/inference service, any SMS provider, any payment SDK.

---

## 4. Architecture overview

The defining feature is that there are **two independent paths out of the client**, and the money path never touches the backend:

- **Data / identity path (backend):** the client syncs the ledger, group membership, identity (ghost/claim/merge), and settlement *state* to Cloudflare Workers + D1. FCM delivers nudges.
- **Money path (device-only):** when a user settles, the client builds a `upi://pay?...` link and hands off to the payer's own UPI app on the same device. This never reaches our servers. We never see, route, or confirm the money.

```
Mobile client (Flutter, offline-first)
  ├── Local SQLite (drift) — working source of truth
  ├── Sync layer — queues mutations, reconciles with server
  └── UPI builder — builds upi:// intent, hands off to UPI app on device ──► GPay / PhonePe / Paytm
        │ (data/identity path)
        ▼
Thin backend (Cloudflare)
  ├── Workers API — groups, expenses, claim, merge, settlements, sync
  ├── D1 ledger — users, ghosts, groups, expenses, splits, settlements
  ├── Merge engine — claim + link accounts (RISKIEST module)
  └── FCM push — settlement nudges
```

---

## 5. Data model

D1 is SQLite. The local drift schema mirrors the synced subset. All IDs are UUID strings generated client-side (enables offline creation). All money amounts are stored as **integer minor units (paise)** to avoid float error — never store rupees as floats.

### 5.1 Core tables (D1 DDL)

```sql
-- A person. A ghost is a user with no login. Merged users are tombstoned, never deleted.
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  google_sub      TEXT UNIQUE,              -- NULL for ghosts
  email           TEXT,                     -- NULL for ghosts
  display_name    TEXT NOT NULL,
  default_upi_id  TEXT,                     -- e.g. name@okhdfc; optional
  is_ghost        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active', -- active | merged | tombstoned
  merged_into     TEXT REFERENCES users(id),      -- set when status = merged
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE groups (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'standard', -- standard | trip
  default_currency TEXT NOT NULL DEFAULT 'INR',
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE TABLE group_members (
  group_id        TEXT NOT NULL REFERENCES groups(id),
  user_id         TEXT NOT NULL REFERENCES users(id),  -- may be a ghost
  role            TEXT NOT NULL DEFAULT 'member',       -- owner | member
  joined_at       INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE expenses (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id),
  description     TEXT NOT NULL,
  amount_total    INTEGER NOT NULL,         -- paise
  currency        TEXT NOT NULL DEFAULT 'INR',
  paid_by         TEXT NOT NULL REFERENCES users(id),
  split_type      TEXT NOT NULL,            -- equal | exact | percent | shares
  txn_date        INTEGER NOT NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER                   -- soft delete (tombstone)
);

-- One row per participant in an expense. The owed portion. Sum of share_amount = amount_total.
CREATE TABLE expense_splits (
  expense_id      TEXT NOT NULL REFERENCES expenses(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  share_amount    INTEGER NOT NULL,         -- paise this user owes for this expense
  PRIMARY KEY (expense_id, user_id)
);

CREATE TABLE settlements (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id),
  from_user       TEXT NOT NULL REFERENCES users(id),
  to_user         TEXT NOT NULL REFERENCES users(id),
  amount          INTEGER NOT NULL,         -- paise
  currency        TEXT NOT NULL DEFAULT 'INR',
  method          TEXT NOT NULL DEFAULT 'upi', -- upi | cash | other
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | marked_paid | confirmed | disputed
  upi_link        TEXT,
  marked_paid_by  TEXT REFERENCES users(id),
  marked_paid_at  INTEGER,
  confirmed_by    TEXT REFERENCES users(id),
  confirmed_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Token-based ghost claiming (no phone/email matching needed)
CREATE TABLE claim_tokens (
  token           TEXT PRIMARY KEY,         -- random, URL-safe
  ghost_user_id   TEXT NOT NULL REFERENCES users(id),
  created_by      TEXT NOT NULL REFERENCES users(id),
  expires_at      INTEGER NOT NULL,
  claimed_by      TEXT REFERENCES users(id),
  claimed_at      INTEGER
);

-- Audit + reversibility for the merge engine
CREATE TABLE merge_records (
  id              TEXT PRIMARY KEY,
  primary_user_id TEXT NOT NULL REFERENCES users(id),  -- survivor (A)
  merged_user_id  TEXT NOT NULL REFERENCES users(id),  -- folded in (B)
  performed_by    TEXT NOT NULL REFERENCES users(id),
  performed_at    INTEGER NOT NULL,
  reversible_until INTEGER NOT NULL,        -- grace window (e.g. +72h)
  reversed_at     INTEGER,
  snapshot        TEXT NOT NULL             -- JSON of B's pre-merge state for reversal
);

-- Household / partner link (§9). NOT an identity merge — two users stay separate.
CREATE TABLE household_links (
  id              TEXT PRIMARY KEY,
  user_a          TEXT NOT NULL REFERENCES users(id),
  user_b          TEXT NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | active | dissolved
  net_balances    INTEGER NOT NULL DEFAULT 1,       -- 1 = net A and B against each other
  created_at      INTEGER NOT NULL,
  confirmed_at    INTEGER
);

-- Idempotency for offline sync (§10)
CREATE TABLE applied_mutations (
  client_mutation_id TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  applied_at         INTEGER NOT NULL
);
```

### 5.2 Identity resolution helper

A single function `effectiveUserId(id)` follows the `merged_into` chain to the live survivor. **Every balance/settlement read MUST resolve through this. No write ever rewrites a historical row to a different user_id.**

```
function effectiveUserId(id):
  seen = {}
  while user[id].status == 'merged':
    if id in seen: throw "merge cycle"   // must never happen; assert
    seen.add(id)
    id = user[id].merged_into
  return id
```

---

## 6. Identity model: ghosts, claiming, merging (CRITICAL)

### 6.1 Ghost members

You can add "Rahul" with just a name (and optionally his UPI ID) and split with him immediately. He is a `users` row with `is_ghost = 1`, `google_sub = NULL`. No invite, no signup required. This is the #1 reason the app is useful on day one.

### 6.2 Token-based claiming

When a ghost is created, mint a `claim_token` and a shareable link (`https://<app>/claim/<token>`). Share via WhatsApp/anywhere. When the recipient opens it and signs in with Google:
- If they have **no** account → the ghost is upgraded in place (`google_sub` set, `is_ghost = 0`).
- If they **already** have an account → run a **merge** (their existing account = A survivor, ghost = B folded in).

The token is the proof of identity. **No phone/email matching.** Email match may be offered later as a convenience hint only, never as the authoritative path.

### 6.3 The merge engine — one primitive, three entry points

"Claim a ghost" and "link my duplicate account" are the same operation: **fold account B into account A.** Entry points:
1. **Claim ghost** — B is a login-less ghost, claimed via token.
2. **Link duplicate** — B is a real account the user controls (signed up twice). User proves control of both, then merge.
3. (Household link is **not** this — see §9.)

### 6.4 HARD RULES (invariants — enforce and test)

- **R1. A survives, B is tombstoned.** Set `B.status = 'merged'`, `B.merged_into = A`. Never hard-delete B. Snapshot B into `merge_records.snapshot`.
- **R2. NEVER recompute or rewrite historical `expense_splits` or `settlements`.** Leave every row exactly as written. Merging changes *identity resolution at read time only* (§5.2).
- **R3. Other people's balances MUST be invariant under merge.** Because per-row amounts never change and a third party C's balance is computed only from C's own untouched split rows, C's net is provably unchanged. This is the property the test matrix exists to guard.
- **R4. Confirm-gated.** Merge requires explicit user confirmation in the UI showing what will be combined.
- **R5. Reversible for a grace window** (e.g. 72h) via `merge_records`. After reversal, all balances return to exactly the pre-merge state.
- **R6. Idempotent.** Re-running a merge of B→A is a no-op. Merging into a tombstoned user must follow `merged_into` to the live survivor.
- **R7. No self-debt artifacts.** If an expense was split between A and B and they're later merged, the UI nets it to zero for that person (you can't owe yourself); it must never surface as a debt and must never alter C.

---

## 7. Expenses & splitting

### 7.1 Split types
- `equal` — divide `amount_total` evenly; assign rounding remainder paise deterministically (e.g. to the payer, or distribute first-N).
- `exact` — caller supplies each share; MUST sum to `amount_total`.
- `percent` — caller supplies percentages summing to 100; convert to paise, fix rounding remainder deterministically.
- `shares` — weighted (e.g. 2:1:1).

Validation rule for all types: `SUM(expense_splits.share_amount) == expenses.amount_total`. Reject otherwise.

### 7.2 Balances
Net balance per (effective) user in a group = `Σ(amounts they paid) − Σ(their split shares)` across non-deleted expenses, then apply confirmed settlements. Positive = owed to them; negative = they owe.

### 7.3 Debt simplification (free, on by default)
Minimize the number of transfers (Splitwise gates the nuance — we give it away).

```
Greedy min-cash-flow:
  1. Compute net balance per effective user in the group.
  2. Split into creditors (net > 0) and debtors (net < 0).
  3. Repeatedly: take the largest creditor and largest debtor,
     transfer t = min(|debtor|, creditor); record transfer; update both.
  4. Drop anyone who reaches 0. Repeat until all zero.
  Result: <= n-1 transfers.
```
Make it **deterministic** (stable sort by amount then user_id) so the suggested transfers don't flicker between recomputes. Always show users the *raw* "who you actually spent with" view alongside the simplified "who to pay" view — the indirection ("pay Priya, not Rahul") is the #1 source of "the app is wrong" confusion, so make it explainable.

---

## 8. Settlement (UPI)

### 8.1 Building the link
Generic UPI intent so the OS app-chooser appears (works on GPay/PhonePe/Paytm). **Do not promise Amazon Pay** — it has been flaky with generic intents.

```
upi://pay?pa=<payee_vpa>&pn=<payee_name>&am=<amount_rupees>&cu=INR&tn=<note>
```
- `pa` = payee VPA (the `to_user`'s `default_upi_id`; if missing, prompt the payee to add one).
- `am` = amount in **rupees with 2 decimals** as a string (convert from paise). Note: `am` is **editable** in some PSP apps — acceptable for a trust-based friends app, not enforceable.
- `tn` = short note, e.g. `"<GroupName> settle"`.

### 8.2 Settlement state machine
```
pending ──(payer taps "I paid")──► marked_paid ──(payee confirms received)──► confirmed
                                        │
                                        └──(payee taps "not received")──► disputed ──► pending
```
- The payer can mark paid **unilaterally** (there's no callback to verify).
- On `marked_paid`, push an FCM nudge to the payee: "Confirm you received ₹X?"
- Set this expectation in onboarding so users aren't surprised that confirmation is manual. This is the same model Splitwise uses for most users — we're not worse, we just manage the expectation.

---

## 9. Household / partner link (headline differentiator)

Two people stay **separate accounts** but settle as one unit. This is a **netting/grouping layer, NOT an identity merge** — much lower risk, and Splitwise handles it badly.

- Create a `household_links` row (A, B), confirm-gated by both.
- When `net_balances = 1`, A and B's balances net against each other across groups, and the household can act as a single payer in a group.
- **No expense splits or settlement rows are rewritten** — this is purely a presentation/netting layer over existing ledger rows. Dissolving the link reverts to separate balances with zero data loss.

---

## 10. Offline-first sync

### 10.1 Model
- The local drift DB is the working source of truth for the user's own edits. The app must fully function with no network (add expense, view balances).
- Every mutation gets a client-generated `client_mutation_id` (UUID) and is appended to a local outbox.
- A background sync worker POSTs the outbox to `POST /sync`, which applies mutations **idempotently** (dedup on `client_mutation_id` via `applied_mutations`) and returns authoritative state plus a server cursor. The client reconciles.

### 10.2 Conflict policy
- Expenses are mostly **append-only**, which sidesteps most conflicts.
- For edits: **per-entity last-write-wins** using server `updated_at`/version.
- Deletes are **soft** (tombstone via `deleted_at`) to prevent resurrection on a late sync from another device.

### 10.3 D1 vs Durable Objects
Default to **D1** for simplicity. If concurrent edits within a single group become messy (multiple people editing one trip live), promote hot groups to **one Durable Object per group** holding that group's ledger and fanning out push. Build the sync API so this swap is an implementation detail behind the same endpoints.

---

## 11. API surface (Cloudflare Workers, REST)

All endpoints require a verified Firebase ID token as `Authorization: Bearer <token>` (§12), except the unauthenticated claim-link landing.

```
POST   /auth/session            verify ID token, upsert user, return profile
GET    /me                      current user
PATCH  /me                      update display_name, default_upi_id

POST   /groups                  create group
GET    /groups                  list my groups
GET    /groups/:id              group detail (members, expenses, balances)
PATCH  /groups/:id              rename, change type/currency
POST   /groups/:id/members      add member (real or ghost)
DELETE /groups/:id/members/:uid remove member (guarded if non-zero balance)

POST   /groups/:id/ghosts       create ghost -> returns { ghost, claim_link }
POST   /claim                   body { token } -> upgrade-in-place OR merge
POST   /merge                   body { primary_user_id, merged_user_id } (confirm-gated)
POST   /merge/:id/reverse       reverse within grace window

POST   /groups/:id/expenses     create expense (+ splits)
PATCH  /expenses/:id            edit (LWW)
DELETE /expenses/:id            soft delete
GET    /groups/:id/balances     net balances + simplified transfers

POST   /groups/:id/settlements  create settlement (returns upi_link)
POST   /settlements/:id/mark-paid
POST   /settlements/:id/confirm
POST   /settlements/:id/dispute

POST   /household-links         propose link
POST   /household-links/:id/confirm
DELETE /household-links/:id     dissolve

POST   /sync                    batched outbox apply + pull (idempotent)
```

---

## 12. Auth flow

1. Client runs Google Sign-In (Firebase Auth). On Android the Google account is on-device → one tap.
2. Client obtains a Firebase **ID token**, sends it as `Bearer` to Workers.
3. Worker verifies the ID token against Firebase's public JWKS (cache keys; check `aud`, `iss`, `exp`).
4. Worker upserts the `users` row keyed by `google_sub`. If this Google account matches a pending claim flow, route to claim/merge.
5. Keep sessions **persistent** — do not force re-auth (no SMS cost here, but re-auth is friction). Apple Sign-In is added when iOS ships.

---

## 13. Monetization (ads-primary)

- **Free tier is the product:** unlimited groups, expenses, trips, debt simplification, UPI settle, multi-currency. No caps. This is the anti-Splitwise wedge and the growth engine.
- **AdMob** is the revenue engine: banner on list screens, interstitial **sparingly** (e.g. after a settle completes — never mid-add-expense), optional native ad in the activity feed. Indian eCPMs are low; do not over-monetize and harm retention.
- **Pro (Phase 3, RevenueCat):** primarily **removes ads**, plus power-user conveniences (CSV/PDF export, spending insights, custom categories, themes). Expect **0.5–1%** conversion — ads carry revenue, Pro is secondary. There is no OCR; do not gate core functionality behind Pro.

---

## 14. Phasing & milestones

### Phase 1 — MVP (shippable wedge)
Auth (Google), groups, **ghost members + token claim**, add expense (equal + exact split), balances, **debt simplification**, **UPI one-tap settle**, settlement state machine (mark-paid / confirm / dispute), **merge engine** (required by claim flow), offline-first sync. Free + AdMob.
**Acceptance:** a user can create a group, add a ghost, log expenses offline, see simplified balances, generate a working `upi://` link that opens GPay/PhonePe pre-filled, and the ghost can claim via link and merge with all history intact and all third-party balances unchanged.

### Phase 2 — differentiation
Trip mode (multi-day, categories, multi-currency given away free), **household/partner link** (headline feature), recurring splits (rent/flatmate), percent & shares split types, iOS + Apple Sign-In.

### Phase 3 — monetization polish
RevenueCat, remove-ads Pro tier, CSV/PDF export, spending insights/charts, themes.

---

## 15. Testing requirements

### 15.1 Merge engine test matrix (build these FIRST)
- **T1 — third-party invariance:** merging B→A must not change any other member C's net balance in any shared group. Assert exact equality before/after.
- **T2 — A|B co-split:** an expense split equally between A and B, then merge → person's net contribution unchanged, nets to zero for self, C unaffected, no self-debt surfaced.
- **T3 — reversibility:** merge then reverse within grace window → all balances return to exactly the pre-merge state.
- **T4 — idempotency:** merging B→A twice is a no-op.
- **T5 — chain follow:** merging into a tombstoned user follows `merged_into` to the live survivor; assert no cycle ever forms.
- **T6 — settlement re-point:** settlements referencing B resolve to A at read time; underlying rows unchanged.
- **T7 — token safety:** expired/invalid/already-claimed token fails closed (no merge).

### 15.2 Settlement state machine tests
Every legal transition and every illegal transition (e.g. confirm before marked_paid must reject). Dispute returns to pending.

### 15.3 Offline sync tests
- Same mutation replayed (same `client_mutation_id`) applies once.
- Two devices edit the same expense offline → LWW resolves deterministically by server version.
- Soft-deleted expense does not resurrect after a late sync.

### 15.4 Money-math tests
- Splits always sum to total (all split types, including rounding remainders).
- All amounts handled as integer paise; no float drift across 1000+ random expenses.

---

## 16. Non-goals / out of scope

- Processing, holding, routing, or auto-confirming payments. **No PSP/payment-aggregator license.**
- UPI "collect"/request-money flows (deprecated by NPCI).
- OCR / receipt parsing / any server-side inference.
- SMS or phone-number auth.
- Guaranteed Amazon Pay support.
- Web client (v1 is mobile-only).

---

## 17. Open decisions for the human

- **Name & branding** (codename "Tally" is a placeholder; could fold under an existing brand system).
- **Multi-currency:** confirmed free, but verify the FX rate source.
- **D1 vs Durable Objects** promotion threshold (§10.3) — start D1, measure.
- **iOS timing** and Apple Sign-In.
- **Ad placement density** — tune against retention after launch.
