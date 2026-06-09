# Offsplit — Build Specification (handoff for Claude Code)

> **Offsplit** — *Split bills / expenses, settle on UPI.* Part of the Offcoder family (alongside Offsync). A Splitwise alternative for India whose wedge is one-tap UPI settlement on a generous, no-paywall free tier.
>
> **Naming/compliance note:** marketing **never** says "make payments" — Offsplit *settles up* by launching a UPI intent the user approves in their own app (§2.1). Use "settle up" / "settle on UPI," never "pay" or "make payments."

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
6. **Generous, no-paywall free tier.** Unlimited groups, expenses, and trips are free forever — this is the growth engine. Monetization is **recurring subscriptions (Plus / Manager) primary; ads are a late, optional, scale-only floor**, off at launch (§13).
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
| Ads | Google AdMob | Scale-only floor, **off at launch** (§13.3) |
| Subscriptions | RevenueCat | **Primary revenue** (Plus / Manager); wired in Phase 2 (§13.5) |

**Explicitly NOT in the stack (Phase 1):** R2 (no receipt images — re-evaluate for Phase 2, §17), any OCR/inference service, any SMS provider, any payment SDK.

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

When a ghost is created, mint a `claim_token` and a shareable link (`https://offsplit.app/claim/<token>`). Share via WhatsApp/anywhere. When the recipient opens it and signs in with Google:
- If they have **no** account → the ghost is upgraded in place (`google_sub` set, `is_ghost = 0`).
- If they **already** have an account → run a **merge** (their existing account = A survivor, ghost = B folded in).

The token is the proof of identity. **No phone/email matching.** Email match may be offered later as a convenience hint only, never as the authoritative path.

**Token hygiene:** claim tokens are **single-use, short-TTL, and bound to the first authenticated open**; rate-limit ghost creation per user to prevent claim-link spam/abuse. Invalid / expired / already-claimed tokens fail closed (§15.1-T7). Tokens travel through WhatsApp link-preview crawlers and chat backups — keep them opaque and random, and never embed anything sensitive beyond the token itself.

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

**Performance (materialized balances):** do not recompute balances by scanning all `expense_splits` and following `merged_into` chains on every read — at scale that becomes the single largest D1 cost line. Keep a per-group `member_balances` cache (paise per effective user), updated incrementally on each mutation and recomputed on merge / reversal. This is **derived state and does NOT violate R2** (§6.4): the immutable split/settlement rows remain the source of truth, and the cache is rebuildable from them at any time.

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

**Nudge reachability limit:** FCM only reaches users who have installed the app. A debtor is often a ghost (no app), so the only nudge channel for them is the creator re-sharing the claim link (WhatsApp is the de-facto notification layer in India). This is an **accepted limitation** — do not add SMS / WhatsApp Business API (cost + the §2 no-SMS rule). Lean on the claim link doubling as the reminder.

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
- **For a money ledger, LWW can silently drop a legitimate edit.** Keep an **append-only mutation/edit log** (event-sourced) so a superseded edit stays recoverable and auditable — extend the append-mostly model from expenses to edits. LWW decides the *current* value; the log preserves *history* (and is the audit trail behind a "the app ate my correction" complaint).

### 10.3 D1 vs Durable Objects
Default to **D1** for simplicity. If concurrent edits within a single group become messy (multiple people editing one trip live), promote hot groups to **one Durable Object per group** holding that group's ledger and fanning out push. Build the sync API so this swap is an implementation detail behind the same endpoints.

**Decide the sharding seam now, even if unused until Phase 2+.** A single D1 has a ~10 GB ceiling and will not hold ~1M active users' ledgers. Either hash-shard by `group_id` across N D1 databases, or adopt the Durable-Object-per-group model above (which shards naturally *and* resolves live concurrent-edit conflicts). The cost is the same either way: **do not bake a single-DB assumption into `/sync` or the data-access layer** — route every query through a group-resolver so the physical store is swappable.

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

## 13. Monetization (free-first; recurring subscriptions primary, ads a scale-only floor)

**Rationale.** The architecture is near-free to run — a few ₹hundred/month at 10k users, ~₹8–17k/month even at 1M MAU; **infra is never the constraint.** The binding constraint is that Indian ad ARPU is only **~₹1–2 per MAU/month**, which makes ads a weak *primary* engine for a low-frequency utility app. So revenue comes from **value people pay for** (recurring subscriptions), and ads are demoted to a late, optional, scale-only floor. Operational break-even for a lean team lands around **~200k MAU** at mid ad-ARPU, so getting there cheaply via the viral claim loop matters more than squeezing early revenue.

### 13.1 Free tier is the product (the growth wedge)
Unlimited groups, expenses, trips, debt simplification, UPI settle, multi-currency. **No caps, ever.** This is the anti-Splitwise wedge and the growth engine. **k-factor (claims per active user) is the #1 growth metric** — the viral ghost→claim loop is the only economically viable acquisition channel (paid installs at India CAC never repay ad ARPU). Never let monetization tax the sharing/retention behaviors that drive virality.

### 13.2 Tiers
- **Plus — ₹99/year (recurring annual; 7-day free trial).** Ad-free + themes + CSV/PDF export + spending insights. Bill **annually, not monthly** — a bill-splitter isn't a monthly-conscious app, and annual billing is ¼ the renewal-failure surface with far less churn/dunning. At ~5× ad-LTV, every subscriber is strongly accretive.
- **Manager — ₹499–999/year (recurring annual).** SMB / power tier for people managing *other people's* money flows: PG/hostel owners, frequent trip organizers, event hosts, flat managers. Multi-group dashboards, member management, bulk reminders, advanced exports. This is where **durable recurring revenue** lives — far lower price sensitivity than consumers; consumer Plus alone is thin at India prices.
- **Plus Lifetime — ₹399 one-time (unpromoted).** Catches the subscription-averse; priced at ~4 years of Plus so it doesn't cannibalize the annual. Offer it, don't push it.

Expect **0.5–1%** consumer conversion — but per-converter leverage is huge (one ₹99/yr sub ≈ ~5 MAU-years of ad revenue), so push Plus harder than a typical "secondary" tier.

### 13.3 Ads (scale-only floor — OFF at launch)
**No ads at launch.** Ads (and therefore the value of "ad-free") only switch on once the product has proven retention + virality at scale, behind a **pre-committed trigger metric** — e.g. introduce ads only after **~200k MAU AND 30-day cohort retention ≥ target AND k-factor stable.** When on: a single unobtrusive native unit and/or **opt-in rewarded** ads — **never interstitials that interrupt a flow** — behind remote config so density can be dialed down if retention dips. Fairness framing for the ad-free upsell: *"You've contributed ~₹X through ads — go ad-free for ₹99/year."*

### 13.4 What we never do
No OCR. **No gating of core functionality** behind a paid tier (the free tier is the wedge). No lending/credit, no data monetization, no becoming a payment router — all incinerate trust in a money-adjacent app and reintroduce the regulatory risk we deliberately designed out (§2, §16).

### 13.5 Engineering implications
- Subscriptions / entitlements via **RevenueCat** (free under $2,500 MTR; 1% above) — **wired in Phase 2, not Phase 3**, since subs are now primary.
- Build **dunning** (grace period + retry + reminder push). Indian card / UPI-mandate renewals fail often; recovery is real recurring money, not an edge case.
- Google Play takes **15%** on subscriptions (first $1M/yr) — model net revenue accordingly.
- Ship the **ad-free entitlement** with Plus from Phase 2 even though ads are off — turning ads on later then becomes a config flip, not a release.

---

## 14. Phasing & milestones

### Phase 1 — MVP (shippable wedge)
Auth (Google), groups, **ghost members + token claim**, add expense (equal + exact split), balances, **debt simplification**, **UPI one-tap settle**, settlement state machine (mark-paid / confirm / dispute), **merge engine** (required by claim flow), offline-first sync. **Free, ad-free, no subscriptions** — pure growth.
**Launches ad-free; no paywall, no subscriptions** (monetization arrives in Phase 2). The only metric that matters here is **k-factor / retention** (§13.1).
**Acceptance:** a user can create a group, add a ghost, log expenses offline, see simplified balances, generate a working `upi://` link that opens GPay/PhonePe pre-filled, and the ghost can claim via link and merge with all history intact and all third-party balances unchanged.

### Phase 2 — differentiation + recurring revenue
Trip mode (multi-day, categories, multi-currency given away free), **household/partner link** (headline feature), recurring splits (rent/flatmate), percent & shares split types, iOS + Apple Sign-In.
**Monetization goes live (subscriptions are primary):** RevenueCat + **Plus (₹99/yr)** — themes, CSV/PDF export, spending insights, and the ad-free entitlement (moot until ads exist, but shipped) — and **Manager (₹499–999/yr)** SMB tier. 7-day free trial + dunning (§13.2, §13.5). Gate monetization on Phase-1 retention/k-factor being healthy.

### Phase 3 — scale monetization & polish
Turn on the **scale-only ad floor** behind the §13.3 trigger metric (minimal native / opt-in rewarded only), the ad-free fairness upsell, **Manager advanced dashboards + bulk reminders**, additional Plus perks (custom categories, charts), and density tuning against retention.

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

- **Name:** decided — **Offsplit** (tagline "Split bills / expenses, settle on UPI"), in the Offcoder / Offsync family. **Domain: `offsplit.app`** (chosen; `.com` is parked/taken, `.in` available as backup). Play Store + App Store names are both free (verified — no existing "Offsplit" app). Remaining before launch: (a) manual trademark search in USPTO TESS + IP India, Nice classes **9 / 36 / 42**; (b) grab `@offsplit` social handles; (c) logo / visual identity.
- **Multi-currency:** confirmed free, but verify the FX rate source.
- **Sharding seam** (§10.3) — start single D1 and measure, but the group-resolver indirection that keeps the store swappable is **not** optional; decide hash-shard-vs-DO before the ~10 GB ceiling is in sight.
- **iOS timing** and Apple Sign-In.
- **Ad introduction trigger + density** (§13.3) — ads are scale-only; finalize the exact MAU / retention / k-factor thresholds and tune density against retention.
- **Plus / Manager pricing** (₹99 / ₹499–999) — validate against measured willingness-to-pay post-launch; confirm the 7-day-trial + annual-only stance.
- **Receipt image attachments (R2)** — re-evaluate for Phase 2 (a top-requested feature, currently out of Phase 1 scope, §3/§16).
