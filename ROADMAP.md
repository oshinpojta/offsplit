# Offsplit — Product Roadmap

> **Split bills / expenses, settle on UPI · A Splitwise alternative for India.**
> India-first · Ghost members + viral claim links · One-tap UPI settle · Generous free tier, recurring-subscription monetization.
> Spec: [`BUILD_SPEC.md`](./BUILD_SPEC.md) · Part of the Off- family (OffCoder, Offsync, Offsplit) · Domain: **offsplit.app**

---

## Status snapshot

> **As of `2026-06-10` (v3)** — **Sprints 1–5 code-complete in one day.** Sprint 3: UPI builder + SettleService (85/85 app tests; hardware check ⚙️). Sprint 4: Workers auth — Firebase JWKS verify at edge, /auth/session, /me (client SDK wiring ⏸ on the Firebase project). Sprint 5: full §11 REST API over D1 — CAS merge/claim (single-statement, batch-atomic), token hardening (T7 no-oracle), role-gated settlements, balances via the shared engine; **22 route tests + 70 engine + 85 app = 177 tests green**, typecheck/analyzer clean. Deploys ⏸ on the ⚙️ Cloudflare account. Next code: Sprint 6 (offline sync) — the last ⚠️ high-risk module. Earlier same day, v2: Sprints 1 AND 2 complete. Sprint 2: offline drift ledger shipped — §5.1 schema, `LedgerRepository` (transactional mutations + incremental `member_balances` cache, S4 whole-doc edits, S5 guarded settlements with M10 cache effects, M4 read-time identity resolution, D5 rebuild + D6 mini-audit), 6-scenario airplane-mode gate suite. **76/76 tests green** (70 engine + 6 ledger), analyzer clean, pushed to `oshinpojta/offsplit@main`. Earlier same day — Sprint 1 (merge engine + money math), test-first as specified: Golden vector suite (`engine-vectors/`, 68 cases pinning M8 rounding, M10 settlement timing, M11 simplification, merge matrix T1–T10, settlement state machine) runs against BOTH engines: TS (`workers/packages/engine`, vitest) and Dart (`app/lib/engine`, flutter_test) — 70/70 green each, plus 2×1000 seeded property cases (identical LCG/seeds cross-language). Engine bonus: percent/shares split types already implemented (Sprint 11 only exposes them in the API/UI). Sprint 0 code rails done (pnpm workers monorepo, Flutter scaffold `offsplit` @ app.offsplit, `offsplit-ci.yml`); Sprint 0 ⚙️ ops items (Cloudflare/Firebase/Sentry/PostHog accounts, domain registration) still pending. Next: Sprint 2 (drift ledger) — or the ⚙️ account setup, which only the human can do.

| Layer | Status |
|---|---|
| `BUILD_SPEC.md` (product + architecture spec) | ✅ Finalized — incl. monetization rewrite (subs-primary, ads scale-only), naming (Offsplit / offsplit.app), token hygiene, materialized balances, sharding seam, edit log |
| `ENGINE_AND_SYNC_DESIGN.md` (M/S/X/D decisions) | ✅ Finalized — merge-writes-one-row, mutation-log sync, golden vectors, robustness layers L1–L5 |
| Name / domain / store availability | ✅ Verified — Play + App Store free, offsplit.app available; ⚙️ register domain, trademark search (classes 9/36/42), grab @offsplit handles |
| `engine-vectors/` (golden fixtures, X1) | ✅ 5 suites / 68 cases — single source of truth for engine behavior |
| `workers/packages/engine` (TS engine) | ✅ 70/70 green (vectors + 2k property cases); strict TS, BigInt-safe rounding |
| `app/lib/engine` (Dart mirror) | ✅ 70/70 green on the same fixtures; analyzer clean |
| `app/` (Flutter client beyond engine) | 📋 Sprint 2 — drift ledger next |
| `workers/api` (Cloudflare Workers + D1) | 📋 Sprint 4/5 |
| `.github/workflows/offsplit-ci.yml` | ✅ Both engine suites on PR/push to staging/master (path-filtered) |
| Firebase project (Auth + FCM) | ⚙️ Not created |
| Cloudflare account (Workers Paid + D1 + wrangler) | ⚙️ Not created |
| CI/CD (GitHub Actions → wrangler deploy staging/prod) | 📋 Not started |
| Sentry + PostHog (k-factor instrumentation) | ⚙️ Projects + keys pending |
| Play Console listing / closed beta | ⚙️ Pending (Phase 1 exit) |
| Monetization (RevenueCat + Play Billing) | 📋 Phase 2 — Plus ₹99/yr · Manager ₹499–999/yr · Lifetime ₹399 |
| Ads (AdMob scale-only floor) | 📋 Phase 3 — gated on ~200k MAU + retention + k-factor triggers (§13.3) |

### Status legend

| Symbol | Meaning |
|---|---|
| ✅ | Done |
| 🚧 | In progress |
| ⏸️ | Blocked / waiting on dependency |
| 📋 | Planned, not started |
| 🔧 | Code work I can do |
| ⚙️ | Operational / external (account setup, legal, deploy, etc.) |

---

## Locked decisions

| Decision | Choice | Notes |
|---|---|---|
| Backend host | **Cloudflare Workers + D1** (spec kept) | Deliberately a separate serverless lane from the house EC2 + Node + Postgres fleet. Offsplit stays operationally independent, near-zero infra (~$5/mo to 100k MAU). Consequence: own ops lane (wrangler + GH Actions + Firebase + Play Console) — no reuse of house deploy scripts/EC2. |
| Auth | **Firebase Auth — Google Sign-In** (spec kept) | One-tap on Android, free to 50k MAU, no SMS. Standalone identity for now; can federate to @offcoder later. |
| Billing | **RevenueCat + Play Billing (IAP)** | Play-policy compliant, simplest dunning/UX. Accepts 15% store cut (vs house Razorpay-web convention) — chosen deliberately. |
| Monetization model | Free-first → **Plus ₹99/yr + Manager ₹499–999/yr** recurring (Phase 2) → ads as scale-only floor (Phase 3) | §13 of BUILD_SPEC. No ads at launch. k-factor is the #1 growth metric. |
| Mobile | Flutter, Android-first; drift (SQLite) local DB, offline-first | iOS + Apple Sign-In in Phase 2. |
| Name | **Offsplit** — "Split bills / expenses, settle on UPI" | Never say "make payments" in any copy (§0 compliance note). |

### Reuse from the house (despite the different backend)

- 🔧 **Flutter `core/` skeleton** from `android/lib/core/` — Dio interceptor stack (auth-refresh; 402-entitlement-retry pattern maps onto RevenueCat gating), `storage` (SecureStorage + SharedPreferences), `router` (GoRouter + deep-link guards → `https://offsplit.app/claim/<token>`), `theme`, no-op Sentry/PostHog analytics wrapper.
- 🔧 **Feature layout convention** — `features/{feature}/{models,data,providers,presentation}` with Riverpod + Freezed.
- 🔧 **Brand assets** from `branding/` — hexagon+slash mark (slash = only colored element), Atlas/Ember palette, Inter 400/500 + JetBrains Mono, one CTA per screen.
- 🔧 **Process** — `staging` → `master` branch flow, CI gates then deploy, security hardening in Sprint 0 (not later), PostHog wired from day one.
- ⚠️ **Net-new (no house precedent):** Cloudflare Workers/D1/wrangler (greenfield ops, mild learning curve) and drift/offline-first local DB (house Flutter app has no local DB). The sync layer carries the schedule risk.

---

## Effort & timeline summary

Estimates are focused dev-days for one experienced Flutter+TS dev (Claude-Code-assisted, ±30%); calendar applies ~65% real-world efficiency. Excludes logo/visual identity, marketing, store-review wait time.

| Milestone | Effort | Solo calendar | 2-dev calendar |
|---|---|---|---|
| **Phase 1 MVP shipped** (Sprints 0–8) | ~66 dev-days | ~4–5 months | ~2–2.5 months |
| **Phase 2 monetizing** (Sprints 9–13) | +~49 dev-days | ~7–9 months cumulative | ~4–5 months cumulative |
| **Phase 3 scale-ready** (Sprints 14–16) | +~32 dev-days | ~9–11 months cumulative | ~5–6 months cumulative |

**Critical path:** Sprint 1 (merge engine) → 2 (local ledger) → 4/5 (auth + API) → 6 (sync) → 7 (claim flow). UI (Sprint 3 onward) parallelizes once the local ledger exists — that's what a second dev unlocks. **Overrun risks:** Sprint 1 (money-corrupting module) and Sprint 6 (distributed sync) — pad these, never compress.

---

## Phase 1 — MVP (shippable wedge) · Sprints 0–8

Ships **free, ad-free, no subscriptions** — pure growth. Phase-1 exit = BUILD_SPEC §14 acceptance: create group → add ghost → log expenses offline → simplified balances → working `upi://` link opens GPay/PhonePe pre-filled → ghost claims via link and merges with history intact and third-party balances unchanged.

### Sprint 0 — Scaffold + accounts + rails _(~4 dev-days)_ 🚧

- [x] 🔧 Repo layout — `offsplit/app/` (Flutter) + `offsplit/workers/` (pnpm monorepo: `packages/engine` now, `api` later) + `engine-vectors/`
- [x] 🔧 Flutter scaffold (`offsplit` @ `app.offsplit`, android+ios) — house `core/` skeleton (network/storage/router/theme/analytics) + brand assets land with Sprint 2/8 UI work
- [x] 🔧 CI — `offsplit-ci.yml`: TS typecheck+test and Flutter analyze+test on PR/push (path-filtered); `wrangler deploy` + D1 migrations steps added when `workers/api` exists (Sprint 5)
- [ ] ⚙️ Cloudflare account — Workers Paid ($5/mo), D1 staging + prod databases, wrangler auth
- [ ] ⚙️ Firebase project — Google Sign-In enabled, FCM; Android app registered (SHA-1/SHA-256)
- [ ] ⚙️ Sentry + PostHog projects + keys (no-op wrappers from day one; k-factor events are a launch blocker, not a nice-to-have)
- [ ] ⚙️ Register **offsplit.app** (+ offsplit.in backup) on Cloudflare DNS; @offsplit handles; trademark search classes 9/36/42

### Sprint 1 — Merge engine + money math, test-first & headless ⚠️ _(~8 dev-days)_ ✅ `2026-06-10`

The single riskiest module (BUILD_SPEC §0, §6). Built exactly as specified: **vectors first, then the TS engine, then the Dart mirror** — both run the identical fixtures (X1).

- [x] 🔧 **§15.1 test matrix as golden vectors** (`engine-vectors/merge/merge-matrix.json`): T1 third-party invariance · T2 A|B co-split/self-debt · T3 reversibility · T4 idempotency · T5a/b chain follow + no-cycle · T6 settlement re-point · T9a/b offline-window write (resolves to A; back to B after reversal) — T7 token fail-closed lives at the API layer (Sprint 5/7) per design doc
- [x] 🔧 Money-math vectors (§15.4/M8): all four split types incl. rounding remainders, ties, zero-share edges, every error code; settlement balance timing (M10) pinned in `balances/` + `settlement/` suites
- [x] 🔧 `effectiveUserId()` resolver (merged_into chain walk, cycle tripwire) — TS + Dart
- [x] 🔧 Merge primitive — `planMerge` (resolution-first, M3) + `applyMergePlan` (writes exactly one row, A0/M2) + `applyReverse`; `merge_records` snapshot + 72h window are the D1 adapter's job (Sprint 5)
- [x] 🔧 Balance computation (net + raw pairwise with R7 self-debt filter) + **deterministic greedy min-cash-flow simplification** (M11) + conservation assert (D6 invariant #1)
- [x] 🔧 Split engines — equal + exact **+ percent + shares** (same largest-remainder core, so Phase 2 gets them free; API/UI exposure stays Sprint 11)
- [x] 🔧 Bounds (₹100cr amount cap, 50-participant cap — D2) + seeded property tests, 1000 cases × 2 suites, **identical LCG + seeds in TS and Dart** (D8)
- **Gate MET:** 70/70 green in TS (vitest) and 70/70 in Dart (flutter_test) on the same vector files; analyzers clean; CI enforces both on every PR.

### Sprint 2 — Local drift ledger (offline-first core) _(~6 dev-days)_ ✅ `2026-06-10`

- [x] 🔧 drift schema (`app/lib/data/db.dart`) mirroring BUILD_SPEC §5.1 synced subset; client UUIDs; integer paise; CHECK constraints (D2/L3)
- [x] 🔧 `LedgerRepository` CRUD — groups, members, **ghosts**, expenses + splits (all four split types via engine), **whole-document edits (S4)**, idempotent soft-delete tombstones; every mutation + its cache update in ONE transaction (L2)
- [x] 🔧 Settlement lifecycle — guarded transitions (S5) with M10 cache effects (apply on marked_paid, revert on disputed)
- [x] 🔧 Balance views — raw pairwise "who you spent with" + simplified "who to pay" (§7.3), identity resolved at read time (M4)
- [x] 🔧 Materialized `member_balances` cache — stores RAW user ids so **merges never touch it** (effective view = aggregation at read); `rebuildBalanceCache` (D5) + `auditBalanceCache` mini-audit with conservation check (D6)
- **Gate MET:** full group → ghosts → expenses → balances flow on in-memory DB with zero network; 6-scenario suite incl. merge-agnostic-cache proof; 76/76 total green, analyzer clean.

### Sprint 3 — UPI settle + settlement state machine _(~4 dev-days)_ ✅ code `2026-06-10` (⚙️ device check pending)

- [x] 🔧 UPI intent builder (`app/lib/features/settle/upi_link.dart`) — `upi://pay?pa=&pn=&am=&cu=INR&tn=`; integer-only paise→rupees (the single conversion point); VPA shape validation; 80-char note clip
- [x] 🔧 Settlement state machine + tests — done in Sprint 1 engine (§15.2 vectors) + Sprint 2 repository wiring
- [x] 🔧 `SettleService` — settlement→link wiring, persisted `upi_link`, `missing_vpa` typed error drives the prompt-payee flow, `setUserVpa`
- [ ] ⚙️ Real-device verification: GPay + PhonePe + Paytm open pre-filled (needs human + handset)
- **Gate:** code half MET (85/85 app tests); hardware half awaits ⚙️

### Sprint 4 — Auth (Firebase Google Sign-In) _(~4 dev-days)_ ✅ server half `2026-06-10` (client SDK wiring ⏸ on Firebase project)

- [x] 🔧 Workers: Firebase ID-token verification at edge (`jose`, Google securetoken JWK set, per-isolate cache, `AUTH_JWKS_JSON` test/pinning override; `iss`/`aud`/`exp`/RS256 enforced)
- [x] 🔧 `POST /auth/session` upsert by `google_sub` (sign-in resolves tombstoned accounts to survivor — M6) · `GET/PATCH /me` with VPA validation
- [x] 🔧 Auth tests through the production verify path: self-signed RS256 JWTs — valid / garbage / wrong-aud / **expired** / session-required
- [ ] ⏸ Flutter: firebase_auth + google_sign_in SDK wiring + Dio interceptor — **blocked on ⚙️ Firebase project** (google-services.json); server contract is ready and tested

### Sprint 5 — Workers API + D1 _(~7 dev-days)_ ✅ `2026-06-10` (deploy ⏸ on Cloudflare account)

- [x] 🔧 D1 DDL migration (§5.1 full schema incl. `applied_mutations`, `claim_tokens`, `merge_records`, `household_links`, `rate_limits`; CHECKs = L3)
- [x] 🔧 REST surface (§11): groups (owner-only PATCH), members (balance-guarded removal), ghosts (+claim link, 7d TTL), expenses (S4 whole-doc PATCH, soft DELETE), balances (shared engine, per currency), settlements (server-side `upi_link`, role-gated transitions + stale-transition CAS), claim, merge + reverse
- [x] 🔧 **Group-resolver seam** (`dbForGroup`) + `D1Like` structural interface — physical store swappable (§10.3); tests run the same store on a node:sqlite shim
- [x] 🔧 Rate limiting (D1-window counters: ghosts 50/day, claims 20/h per user), zod validation, JSON error envelope
- [x] 🔧 Merge = **single-statement CAS** guarding both preconditions + audit INSERT gated on the CAS (atomic `batch` — adapted D1 pattern since D1 has no interactive transactions); claim = single-winner CAS; reversal pair similarly guarded; **T7 fail-closed with generic `claim_invalid` (no oracle)**; GET /claim/:token never mutates
- [x] 🔧 22 route tests against the Sprint-1 engine: authz lockouts, engine math E2E, T1 invariance over HTTP, T3 exact reversal, R6 noop, M10/S5 effects, terminal-confirmed 409s, Phase-1 merge restrictions
- [ ] ⏸ ⚙️ `wrangler deploy` staging/prod + real-D1 migration run — blocked on Cloudflare account (wrangler.toml ready with TODO database ids)

### Sprint 6 — Offline sync ⚠️ _(~8 dev-days)_ 📋

- [ ] 🔧 Client outbox — every mutation gets `client_mutation_id` (UUID), queued locally, background sync worker
- [ ] 🔧 `POST /sync` — batched idempotent apply (dedup via `applied_mutations`) + pull with server cursor; client reconciles
- [ ] 🔧 Per-entity LWW on server version; soft-delete tombstones prevent resurrection
- [ ] 🔧 **Append-only edit log** (§10.2) — LWW decides current value, log preserves history/audit
- [ ] 🔧 Sync test suite (§15.3): replay-once · two-device LWW deterministic · no tombstone resurrection
- [ ] 🔧 Atomic outbox (local write + enqueue in one drift txn), ack discipline, dependency cascade-rejection (DESIGN D4)
- [ ] 🔧 Resync-required path (cursor too old → snapshot rebuild preserving outbox) + versioned balance-cache rebuild (D5)
- [ ] 🔧 **Invariant auditor cron** (Σ net == 0, splits sum, legal settlement states, no cycles) + client mini-audit on group open (D6)
- [ ] 🔧 **Sync simulation suite** — N virtual devices, random partitions/reorders/replays/crashes → convergence + invariants (D8)
- **Gate:** all §15.3 tests + simulation suite green; kill-network/restore round-trips clean. Build to DESIGN S1–S10/D4–D6/D8.

### Sprint 7 — Claim flow end-to-end (the viral loop) _(~5 dev-days)_ 📋

- [ ] 🔧 Token mint on ghost creation → `https://offsplit.app/claim/<token>` share sheet (WhatsApp-first)
- [ ] 🔧 Claim landing (unauthenticated Workers route) → app deep link / Play fallback
- [ ] 🔧 `POST /claim` — no account → upgrade ghost in place; existing account → confirm-gated merge (Sprint-1 engine)
- [ ] 🔧 `POST /merge` + `POST /merge/:id/reverse` (72h window)
- [ ] 🔧 Token hygiene (§6.2): single-use, short-TTL, bind on first authenticated open, fail closed
- [ ] 🔧 PostHog k-factor funnel: ghost_created → link_shared → link_opened → claimed
- **Gate:** §14 acceptance scenario passes end-to-end on real devices

### Sprint 8 — UI/UX polish + FCM + beta + launch _(~19 dev-days)_ 📋

- [ ] 🔧 Full app UI — onboarding (sets manual-confirmation expectation §8.2), groups list/detail, add-expense flow, balances with raw-vs-simplified explainer, settle flow, activity feed, settings
- [ ] 🔧 FCM — settlement nudge to payee on marked_paid ("Confirm you received ₹X?")
- [ ] 🔧 Empty states, error states, loading skeletons; brand pass (Ember CTA discipline)
- [ ] 🔧 Device matrix QA + fix pass
- [ ] 🔧 **Launch blockers:** D7 optimistic-vs-authoritative mismatch telemetry + D9 metrics/alerts (auditor violations, reject-rate, resync rate) live before rollout
- [ ] ⚙️ Play Console — listing ("Offsplit — Split bills & settle on UPI"; **never "make payments"**), closed beta track, data-safety form
- [ ] ⚙️ Privacy policy + ToS at offsplit.app/legal/*
- [ ] ⚙️ Production launch + staged rollout

---

## Phase 2 — Differentiation + recurring revenue · Sprints 9–13 _(~49 dev-days)_ 📋

Monetization goes live **only if Phase-1 retention/k-factor are healthy** (§14). Subscriptions are primary revenue.

### Sprint 9 — Trip mode _(~7 dev-days)_
- [ ] 🔧 `type = trip` groups — multi-day, categories, per-day view
- [ ] 🔧 Multi-currency (free, §13.1); ⚙️ pick FX rate source (§17)

### Sprint 10 — Household / partner link (headline differentiator) _(~6 dev-days)_
- [ ] 🔧 `household_links` — propose/confirm-both/dissolve; netting layer over existing rows, zero rewrites (§9)
- [ ] 🔧 Cross-group A↔B netting + household-as-single-payer presentation

### Sprint 11 — Split-type completion + recurring _(~7 dev-days)_
- [ ] 🔧 Percent + shares split types (+ rounding-remainder tests)
- [ ] 🔧 Recurring splits (rent/flatmate) — schedule + auto-create

### Sprint 12 — Subscriptions: Plus + Manager _(~16 dev-days)_
- [ ] 🔧 RevenueCat SDK + entitlements; **Plus ₹99/yr** (7-day trial) · **Manager ₹499–999/yr** · Lifetime ₹399 (unpromoted)
- [ ] 🔧 Plus features — themes, CSV/PDF export, spending insights; **ad-free entitlement shipped now** (ads off → later config flip, §13.5)
- [ ] 🔧 Manager v1 — multi-group dashboard, member management
- [ ] 🔧 Dunning — grace period + retry + reminder push (§13.5)
- [ ] 🔧 Paywall UI — free tier never gated (§13.4)
- [ ] ⚙️ Play Billing products + RevenueCat config

### Sprint 13 — iOS _(~13 dev-days)_
- [ ] 🔧 iOS build, Apple Sign-In, UPI-link behavior audit on iOS PSP apps
- [ ] ⚙️ App Store listing + review

---

## Phase 3 — Scale monetization + hardening · Sprints 14–16 _(~32 dev-days)_ 📋

### Sprint 14 — Ads floor (gated) _(~7 dev-days)_
- [ ] ⏸️ **Gate: §13.3 triggers** — ~200k MAU AND 30-day retention ≥ target AND k-factor stable. Do not build early.
- [ ] 🔧 AdMob — single native unit and/or opt-in rewarded only; never flow-interrupting interstitials; remote-config density dial
- [ ] 🔧 Fairness upsell — "You've contributed ~₹X through ads — go ad-free for ₹99/yr"

### Sprint 15 — Manager depth + Plus perks v2 _(~12 dev-days)_
- [ ] 🔧 Manager — advanced dashboards, bulk reminders, advanced exports
- [ ] 🔧 Plus — custom categories, charts

### Sprint 16 — Scale hardening _(~13 dev-days)_
- [ ] 🔧 D1 sharding or DO-per-group promotion behind the group-resolver (decide on metrics, §10.3 — before the ~10 GB D1 ceiling is in sight)
- [ ] 🔧 Perf pass — sync batching, balance-cache tuning, cold-start
- [ ] 🔧 Retention/A-B tuning loop (ongoing)

---

## Unit economics (reference)

From the BUILD_SPEC §13 analysis (2026 pricing):

| Scale | Infra/mo | Ad revenue/mo (mid ₹1.75/MAU) | Notes |
|---|---|---|---|
| 10k MAU | ~$5 (₹415) | ₹17.5k *(if ads were on)* | Workers base fee only |
| 100k MAU | ~$10 (₹830) | ₹1.75L | Still inside included tiers |
| 1M MAU | ~$100–135 (₹8–11k) | ₹17.5L | Infra ≈ 0.5–0.7% of revenue |

- Operational break-even (lean team ₹3–5L/mo burn): **~100k–450k MAU** depending on ARPU; planning number **~200k MAU**.
- Paid acquisition can never repay India ad ARPU → **the claim-link loop is the only viable CAC strategy**; k-factor is the metric that decides everything.
- One Plus subscriber ≈ ~5 MAU-years of ad revenue → push Plus harder than a typical "secondary" tier.

---

## Open items (mirrors BUILD_SPEC §17)

- ⚙️ Register offsplit.app / offsplit.in; @offsplit social handles; trademark search (Nice 9/36/42)
- ⚙️ Logo / visual identity within the Off- brand system
- 📋 FX rate source for multi-currency (Sprint 9)
- 📋 Sharding decision trigger (Sprint 16 — watch D1 size + hot-group contention)
- 📋 Ad-trigger thresholds finalization (exact MAU/retention/k-factor numbers)
- 📋 Plus/Manager price validation post-launch
- 📋 Receipt images via R2 — re-evaluate for Phase 2 (top-requested feature, §3/§16)
