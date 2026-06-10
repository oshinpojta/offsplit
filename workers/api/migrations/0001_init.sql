-- Offsplit D1 schema (BUILD_SPEC §5.1). All money INTEGER paise (M7);
-- all timestamps epoch milliseconds; ids are client/server UUID strings.
-- CHECK constraints are defense layer L3 (ENGINE_AND_SYNC_DESIGN Part D).

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  google_sub      TEXT UNIQUE,
  email           TEXT,
  display_name    TEXT NOT NULL,
  default_upi_id  TEXT,
  is_ghost        INTEGER NOT NULL DEFAULT 0 CHECK (is_ghost IN (0, 1)),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'tombstoned')),
  merged_into     TEXT REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'standard' CHECK (type IN ('standard', 'trip')),
  default_currency TEXT NOT NULL DEFAULT 'INR',
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);

CREATE TABLE group_members (
  group_id   TEXT NOT NULL REFERENCES groups(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_members_user ON group_members(user_id);

CREATE TABLE expenses (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id),
  description  TEXT NOT NULL,
  amount_total INTEGER NOT NULL CHECK (amount_total > 0),
  currency     TEXT NOT NULL DEFAULT 'INR',
  paid_by      TEXT NOT NULL REFERENCES users(id),
  split_type   TEXT NOT NULL CHECK (split_type IN ('equal', 'exact', 'percent', 'shares')),
  txn_date     INTEGER NOT NULL,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX idx_expenses_group ON expenses(group_id, deleted_at);

CREATE TABLE expense_splits (
  expense_id   TEXT NOT NULL REFERENCES expenses(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  share_amount INTEGER NOT NULL CHECK (share_amount >= 0),
  PRIMARY KEY (expense_id, user_id)
);

CREATE TABLE settlements (
  id             TEXT PRIMARY KEY,
  group_id       TEXT NOT NULL REFERENCES groups(id),
  from_user      TEXT NOT NULL REFERENCES users(id),
  to_user        TEXT NOT NULL REFERENCES users(id),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  currency       TEXT NOT NULL DEFAULT 'INR',
  method         TEXT NOT NULL DEFAULT 'upi' CHECK (method IN ('upi', 'cash', 'other')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'marked_paid', 'confirmed', 'disputed')),
  upi_link       TEXT,
  marked_paid_by TEXT REFERENCES users(id),
  marked_paid_at INTEGER,
  confirmed_by   TEXT REFERENCES users(id),
  confirmed_at   INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_settlements_group ON settlements(group_id);

CREATE TABLE claim_tokens (
  token         TEXT PRIMARY KEY,
  ghost_user_id TEXT NOT NULL REFERENCES users(id),
  created_by    TEXT NOT NULL REFERENCES users(id),
  expires_at    INTEGER NOT NULL,
  claimed_by    TEXT REFERENCES users(id),
  claimed_at    INTEGER
);
CREATE INDEX idx_claim_tokens_ghost ON claim_tokens(ghost_user_id);

CREATE TABLE merge_records (
  id               TEXT PRIMARY KEY,
  primary_user_id  TEXT NOT NULL REFERENCES users(id),
  merged_user_id   TEXT NOT NULL REFERENCES users(id),
  performed_by     TEXT NOT NULL REFERENCES users(id),
  performed_at     INTEGER NOT NULL,
  reversible_until INTEGER NOT NULL,
  reversed_at      INTEGER,
  snapshot         TEXT NOT NULL
);
CREATE INDEX idx_merge_records_merged ON merge_records(merged_user_id);

CREATE TABLE household_links (
  id           TEXT PRIMARY KEY,
  user_a       TEXT NOT NULL REFERENCES users(id),
  user_b       TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'dissolved')),
  net_balances INTEGER NOT NULL DEFAULT 1 CHECK (net_balances IN (0, 1)),
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER
);

-- Idempotency for offline sync (§10, Sprint 6 wiring)
CREATE TABLE applied_mutations (
  client_mutation_id TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  applied_at         INTEGER NOT NULL
);

-- Lightweight rate limiting (D3): fixed windows keyed by caller+action.
CREATE TABLE rate_limits (
  rl_key       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
