/**
 * Offsplit REST API (§11). Hono on Cloudflare Workers. Auth: Firebase ID
 * tokens (§12). Every group-scoped route checks effective membership (M4 at
 * the authz layer). Settlement status moves only through guarded transitions
 * (S5). The claim flow is the viral loop's server half (§6.2): GET never
 * mutates; claiming is an authenticated POST behind a single-winner CAS.
 */
import {
  applySettlementTransition,
  computeNetBalances,
  computePairwiseDebts,
  computeShares,
  EngineError,
  simplifyDebts,
  type ExpenseRecord,
  type SettlementRecord,
  type SplitParticipant,
} from '@offsplit/engine';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { bearerToken, verifyFirebaseIdToken } from './auth.js';
import { dbForGroup, rootDb, type Env } from './d1.js';
import { ApiError, badRequest, claimInvalid, forbidden, notFound } from './errors.js';
import * as store from './store.js';
import { buildUpiPayLink, VPA_PATTERN } from './vpa.js';

type Vars = { userId: string };
type AppContext = Context<{ Bindings: Env; Variables: Vars }>;
export const CLAIM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (D3)

const participantSchema = z.object({
  user_id: z.string().min(1),
  amount: z.number().int().optional(),
  bp: z.number().int().optional(),
  weight: z.number().int().optional(),
});

const expenseBodySchema = z.object({
  description: z.string().min(1).max(200),
  amount_total: z.number().int(),
  currency: z.string().length(3).optional(),
  paid_by: z.string().min(1),
  split_type: z.enum(['equal', 'exact', 'percent', 'shares']),
  participants: z.array(participantSchema).min(1),
  txn_date: z.number().int().optional(),
});

function engineParticipants(raw: z.infer<typeof participantSchema>[]): SplitParticipant[] {
  return raw.map((p) => ({
    userId: p.user_id,
    ...(p.amount !== undefined ? { amount: p.amount } : {}),
    ...(p.bp !== undefined ? { bp: p.bp } : {}),
    ...(p.weight !== undefined ? { weight: p.weight } : {}),
  }));
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest('validation_failed', result.error.issues[0]?.message);
  }
  return result.data;
}

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.code, message: err.message }, err.status as 400);
    }
    if (err instanceof EngineError) {
      const status = err.code === 'illegal_transition' ? 409 : 400;
      return c.json({ error: err.code }, status);
    }
    console.error('unhandled', err);
    return c.json({ error: 'internal' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // Unauthenticated claim landing (§11): pure read — GET never mutates (D3).
  app.get('/claim/:token', (c) =>
    c.json({
      app: 'offsplit',
      action: 'install_or_open',
      claim_token: c.req.param('token'),
    }),
  );

  // ── Auth ───────────────────────────────────────────────────────────────

  app.post('/auth/session', async (c) => {
    const identity = await verifyFirebaseIdToken(
      bearerToken(c.req.header('Authorization')),
      c.env,
    );
    const user = await store.upsertUserBySub(rootDb(c.env), identity, Date.now());
    return c.json({ user: publicUser(user) });
  });

  // Everything below requires a registered user.
  app.use('*', async (c, next) => {
    const identity = await verifyFirebaseIdToken(
      bearerToken(c.req.header('Authorization')),
      c.env,
    );
    const db = rootDb(c.env);
    const row = await db
      .prepare('SELECT id FROM users WHERE google_sub = ?')
      .bind(identity.sub)
      .first<{ id: string }>();
    if (!row) throw new ApiError(401, 'session_required');
    c.set('userId', await store.effectiveUserId(db, row.id)); // M6
    await next();
  });

  app.get('/me', async (c) =>
    c.json({ user: publicUser(await store.mustGetUser(rootDb(c.env), c.get('userId'))) }),
  );

  app.patch('/me', async (c) => {
    const body = parse(
      z.object({
        display_name: z.string().min(1).max(80).optional(),
        default_upi_id: z.string().regex(VPA_PATTERN).nullable().optional(),
      }),
      await c.req.json(),
    );
    const db = rootDb(c.env);
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];
    if (body.display_name !== undefined) {
      sets.unshift('display_name = ?');
      params.unshift(body.display_name);
    }
    if (body.default_upi_id !== undefined) {
      sets.unshift('default_upi_id = ?');
      params.unshift(body.default_upi_id);
    }
    await db
      .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...params, c.get('userId'))
      .run();
    return c.json({ user: publicUser(await store.mustGetUser(db, c.get('userId'))) });
  });

  // ── Groups ─────────────────────────────────────────────────────────────

  app.post('/groups', async (c) => {
    const body = parse(
      z.object({
        name: z.string().min(1).max(80),
        type: z.enum(['standard', 'trip']).optional(),
        currency: z.string().length(3).optional(),
      }),
      await c.req.json(),
    );
    const db = rootDb(c.env);
    const now = Date.now();
    const id = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          `INSERT INTO groups (id, name, type, default_currency, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, body.name, body.type ?? 'standard', body.currency ?? 'INR', c.get('userId'), now, now),
      db
        .prepare(
          `INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`,
        )
        .bind(id, c.get('userId'), now),
    ]);
    return c.json({ group: await store.mustGetGroup(db, id) }, 201);
  });

  app.get('/groups', async (c) =>
    c.json({ groups: await store.listGroupsFor(rootDb(c.env), c.get('userId')) }),
  );

  app.get('/groups/:id', async (c) => {
    const groupId = c.req.param('id');
    const db = dbForGroup(c.env, groupId);
    const group = await store.mustGetGroup(db, groupId);
    await assertMember(db, groupId, c.get('userId'));
    const memberIds = await store.listMemberUserIds(db, groupId);
    const members = [];
    for (const id of memberIds) {
      members.push(publicUser(await store.mustGetUser(db, id)));
    }
    return c.json({ group, members, balances: await groupBalances(db, groupId) });
  });

  app.patch('/groups/:id', async (c) => {
    const groupId = c.req.param('id');
    const db = dbForGroup(c.env, groupId);
    await store.mustGetGroup(db, groupId);
    await assertOwner(db, groupId, c.get('userId'));
    const body = parse(
      z.object({
        name: z.string().min(1).max(80).optional(),
        type: z.enum(['standard', 'trip']).optional(),
        default_currency: z.string().length(3).optional(),
      }),
      await c.req.json(),
    );
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];
    for (const [column, value] of [
      ['name', body.name],
      ['type', body.type],
      ['default_currency', body.default_currency],
    ] as const) {
      if (value !== undefined) {
        sets.unshift(`${column} = ?`);
        params.unshift(value);
      }
    }
    await db
      .prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...params, groupId)
      .run();
    return c.json({ group: await store.mustGetGroup(db, groupId) });
  });

  app.post('/groups/:id/members', async (c) => {
    const groupId = c.req.param('id');
    const db = dbForGroup(c.env, groupId);
    await store.mustGetGroup(db, groupId);
    await assertMember(db, groupId, c.get('userId'));
    const body = parse(z.object({ user_id: z.string().min(1) }), await c.req.json());
    await store.mustGetUser(db, body.user_id);
    await db
      .prepare(
        `INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
      )
      .bind(groupId, body.user_id, Date.now())
      .run();
    return c.json({ ok: true }, 201);
  });

  // Guarded if non-zero balance (§11).
  app.delete('/groups/:id/members/:uid', async (c) => {
    const groupId = c.req.param('id');
    const targetId = c.req.param('uid');
    const db = dbForGroup(c.env, groupId);
    await store.mustGetGroup(db, groupId);
    const caller = c.get('userId');
    if (targetId !== caller) await assertOwner(db, groupId, caller);
    const balances = await groupBalances(db, groupId);
    const effectiveTarget = await store.effectiveUserId(db, targetId);
    for (const currency of Object.values(balances)) {
      if ((currency.net[effectiveTarget] ?? 0) !== 0) {
        throw new ApiError(409, 'member_has_balance');
      }
    }
    await db
      .prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, targetId)
      .run();
    return c.body(null, 204);
  });

  // ── Ghosts + claim links (§6.1/6.2) ────────────────────────────────────

  app.post('/groups/:id/ghosts', async (c) => {
    const groupId = c.req.param('id');
    const db = dbForGroup(c.env, groupId);
    await store.mustGetGroup(db, groupId);
    const caller = c.get('userId');
    await assertMember(db, groupId, caller);
    const now = Date.now();
    await store.bumpRateLimit(db, `ghosts:${caller}`, 24 * 60 * 60 * 1000, 50, now); // D3
    const body = parse(
      z.object({
        display_name: z.string().min(1).max(80),
        upi_id: z.string().regex(VPA_PATTERN).optional(),
      }),
      await c.req.json(),
    );
    const ghostId = crypto.randomUUID();
    const token = store.mintTokenString();
    await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, display_name, default_upi_id, is_ghost, status, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'active', ?, ?)`,
        )
        .bind(ghostId, body.display_name, body.upi_id ?? null, now, now),
      db
        .prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
        .bind(groupId, ghostId, now),
      db
        .prepare(
          'INSERT INTO claim_tokens (token, ghost_user_id, created_by, expires_at) VALUES (?, ?, ?, ?)',
        )
        .bind(token, ghostId, caller, now + CLAIM_TOKEN_TTL_MS),
    ]);
    return c.json(
      {
        ghost: publicUser(await store.mustGetUser(db, ghostId)),
        claim_token: token,
        claim_link: `https://offsplit.app/claim/${token}`,
      },
      201,
    );
  });

  // Claim = merge ghost INTO caller (one primitive, §6.3). CAS: one winner.
  app.post('/claim', async (c) => {
    const body = parse(z.object({ token: z.string().min(16) }), await c.req.json());
    const db = rootDb(c.env);
    const caller = c.get('userId');
    const now = Date.now();
    await store.bumpRateLimit(db, `claim:${caller}`, 60 * 60 * 1000, 20, now); // D3
    const claimed = await store.claimTokenCas(db, body.token, caller, now);
    if (!claimed) throw claimInvalid(); // T7: invalid/expired/used — indistinguishable
    const outcome = await store.mergeUsers(db, caller, claimed.ghost_user_id, caller, now);
    return c.json({
      result: outcome.kind,
      user: publicUser(await store.mustGetUser(db, outcome.survivorId)),
      merge_record_id: outcome.mergeRecordId ?? null,
      reversible_until: outcome.reversibleUntil ?? null,
    });
  });

  // ── Merge / reverse (§6.3; Phase-1 restriction — see decision log) ─────

  app.post('/merge', async (c) => {
    const body = parse(
      z.object({ merged_user_id: z.string().min(1), confirm: z.literal(true) }), // R4
      await c.req.json(),
    );
    const db = rootDb(c.env);
    const caller = c.get('userId');
    const target = await store.mustGetUser(db, body.merged_user_id);
    if (target.is_ghost !== 1 || target.google_sub !== null) {
      throw forbidden('merge_requires_claim'); // real accounts merge via claim token only
    }
    // Caller must share a group with the ghost.
    const ghostGroups = await store.listGroupsFor(db, target.id);
    let shares = false;
    for (const g of ghostGroups) {
      if (await store.isEffectiveMember(db, g.id, caller)) {
        shares = true;
        break;
      }
    }
    if (!shares) throw forbidden('merge_requires_shared_group');
    const outcome = await store.mergeUsers(db, caller, target.id, caller, Date.now());
    return c.json({
      result: outcome.kind,
      survivor_id: outcome.survivorId,
      merge_record_id: outcome.mergeRecordId ?? null,
      reversible_until: outcome.reversibleUntil ?? null,
    });
  });

  app.post('/merge/:id/reverse', async (c) => {
    await store.reverseMerge(rootDb(c.env), c.req.param('id'), c.get('userId'), Date.now());
    return c.json({ ok: true });
  });

  // ── Expenses (§7) ──────────────────────────────────────────────────────

  app.post('/groups/:id/expenses', async (c) => {
    const groupId = c.req.param('id');
    const db = dbForGroup(c.env, groupId);
    const group = await store.mustGetGroup(db, groupId);
    await assertMember(db, groupId, c.get('userId'));
    const body = parse(expenseBodySchema, await c.req.json());
    await assertParticipantsAreMembers(db, groupId, body);
    const shares = computeShares({
      splitType: body.split_type,
      amountTotal: body.amount_total,
      participants: engineParticipants(body.participants),
    });
    const now = Date.now();
    const expenseId = crypto.randomUUID();
    const statements = [
      db
        .prepare(
          `INSERT INTO expenses (id, group_id, description, amount_total, currency, paid_by, split_type, txn_date, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          expenseId,
          groupId,
          body.description,
          body.amount_total,
          body.currency ?? group.default_currency,
          body.paid_by,
          body.split_type,
          body.txn_date ?? now,
          c.get('userId'),
          now,
          now,
        ),
    ];
    for (const [userId, share] of shares) {
      statements.push(
        db
          .prepare(
            'INSERT INTO expense_splits (expense_id, user_id, share_amount) VALUES (?, ?, ?)',
          )
          .bind(expenseId, userId, share),
      );
    }
    await db.batch(statements);
    return c.json({ expense: await getExpenseWithSplits(db, expenseId) }, 201);
  });

  // Whole-document edit (S4): full splits replace the old set atomically.
  app.patch('/expenses/:id', async (c) => {
    const expenseId = c.req.param('id');
    const db = rootDb(c.env);
    const existing = await db
      .prepare('SELECT * FROM expenses WHERE id = ?')
      .bind(expenseId)
      .first<store.ExpenseRow>();
    if (!existing || existing.deleted_at !== null) throw notFound('expense_not_found');
    await assertMember(db, existing.group_id, c.get('userId'));
    const body = parse(expenseBodySchema, await c.req.json());
    await assertParticipantsAreMembers(db, existing.group_id, body);
    const shares = computeShares({
      splitType: body.split_type,
      amountTotal: body.amount_total,
      participants: engineParticipants(body.participants),
    });
    const now = Date.now();
    const statements = [
      db.prepare('DELETE FROM expense_splits WHERE expense_id = ?').bind(expenseId),
      db
        .prepare(
          `UPDATE expenses SET description = ?, amount_total = ?, paid_by = ?, split_type = ?, txn_date = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(
          body.description,
          body.amount_total,
          body.paid_by,
          body.split_type,
          body.txn_date ?? existing.txn_date,
          now,
          expenseId,
        ),
    ];
    for (const [userId, share] of shares) {
      statements.push(
        db
          .prepare(
            'INSERT INTO expense_splits (expense_id, user_id, share_amount) VALUES (?, ?, ?)',
          )
          .bind(expenseId, userId, share),
      );
    }
    await db.batch(statements);
    return c.json({ expense: await getExpenseWithSplits(db, expenseId) });
  });

  app.delete('/expenses/:id', async (c) => {
    const expenseId = c.req.param('id');
    const db = rootDb(c.env);
    const existing = await db
      .prepare('SELECT * FROM expenses WHERE id = ?')
      .bind(expenseId)
      .first<store.ExpenseRow>();
    if (!existing) throw notFound('expense_not_found');
    await assertMember(db, existing.group_id, c.get('userId'));
    await db
      .prepare('UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .bind(Date.now(), Date.now(), expenseId)
      .run();
    return c.body(null, 204);
  });

  app.get('/groups/:id/balances', async (c) => {
    const groupId = c.req.param('id');
    const db = dbForGroup(c.env, groupId);
    await store.mustGetGroup(db, groupId);
    await assertMember(db, groupId, c.get('userId'));
    return c.json({ balances: await groupBalances(db, groupId) });
  });

  // ── Settlements (§8) ───────────────────────────────────────────────────

  app.post('/groups/:id/settlements', async (c) => {
    const groupId = c.req.param('id');
    const db = dbForGroup(c.env, groupId);
    const group = await store.mustGetGroup(db, groupId);
    await assertMember(db, groupId, c.get('userId'));
    const body = parse(
      z.object({
        from_user: z.string().min(1),
        to_user: z.string().min(1),
        amount: z.number().int().positive(),
        currency: z.string().length(3).optional(),
        method: z.enum(['upi', 'cash', 'other']).optional(),
      }),
      await c.req.json(),
    );
    if (body.from_user === body.to_user) throw badRequest('self_settlement');
    await assertMember(db, groupId, body.from_user);
    await assertMember(db, groupId, body.to_user);
    const payee = await store.mustGetUser(db, body.to_user);
    const upiLink = payee.default_upi_id
      ? buildUpiPayLink({
          payeeVpa: payee.default_upi_id,
          payeeName: payee.display_name,
          amountPaise: body.amount,
          note: `${group.name} settle`,
        })
      : null;
    const now = Date.now();
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO settlements (id, group_id, from_user, to_user, amount, currency, method, upi_link, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        groupId,
        body.from_user,
        body.to_user,
        body.amount,
        body.currency ?? group.default_currency,
        body.method ?? 'upi',
        upiLink,
        now,
        now,
      )
      .run();
    return c.json({ settlement: await getSettlement(db, id) }, 201);
  });

  const transition = (action: 'mark_paid' | 'confirm' | 'dispute' | 'reset') =>
    async (c: AppContext) => {
      const id = c.req.param('id');
      if (!id) throw notFound('settlement_not_found');
      const db = rootDb(c.env);
      const settlement = await getSettlement(db, id);
      const caller = c.get('userId');
      const payer = await store.effectiveUserId(db, settlement.from_user);
      const payee = await store.effectiveUserId(db, settlement.to_user);
      const allowed =
        action === 'mark_paid' || action === 'reset' ? caller === payer : caller === payee;
      if (!allowed) throw forbidden('settlement_role');
      const next = applySettlementTransition(
        settlement.status as Parameters<typeof applySettlementTransition>[0],
        action,
      ); // S5 guard
      const now = Date.now();
      // CAS on the previous status — a racing transition loses cleanly.
      const result = await db
        .prepare(
          `UPDATE settlements SET status = ?, updated_at = ?,
             marked_paid_by = CASE WHEN ? = 'mark_paid' THEN ? ELSE marked_paid_by END,
             marked_paid_at = CASE WHEN ? = 'mark_paid' THEN ? ELSE marked_paid_at END,
             confirmed_by   = CASE WHEN ? = 'confirm' THEN ? ELSE confirmed_by END,
             confirmed_at   = CASE WHEN ? = 'confirm' THEN ? ELSE confirmed_at END
           WHERE id = ? AND status = ?`,
        )
        .bind(next, now, action, caller, action, now, action, caller, action, now, id, settlement.status)
        .run();
      if (result.meta.changes !== 1) throw new ApiError(409, 'stale_transition');
      return c.json({ settlement: await getSettlement(db, id) });
    };

  app.post('/settlements/:id/mark-paid', transition('mark_paid'));
  app.post('/settlements/:id/confirm', transition('confirm'));
  app.post('/settlements/:id/dispute', transition('dispute'));
  app.post('/settlements/:id/reset', transition('reset'));

  // ── helpers ────────────────────────────────────────────────────────────

  async function assertMember(db: ReturnType<typeof rootDb>, groupId: string, userId: string) {
    if (!(await store.isEffectiveMember(db, groupId, userId))) {
      throw forbidden('not_a_member');
    }
  }

  async function assertOwner(db: ReturnType<typeof rootDb>, groupId: string, userId: string) {
    const owners = await db
      .prepare(`SELECT user_id FROM group_members WHERE group_id = ? AND role = 'owner'`)
      .bind(groupId)
      .all<{ user_id: string }>();
    for (const row of owners.results) {
      if ((await store.effectiveUserId(db, row.user_id)) === userId) return;
    }
    throw forbidden('owner_only');
  }

  async function assertParticipantsAreMembers(
    db: ReturnType<typeof rootDb>,
    groupId: string,
    body: z.infer<typeof expenseBodySchema>,
  ) {
    await assertMember(db, groupId, await store.effectiveUserId(db, body.paid_by));
    for (const p of body.participants) {
      await assertMember(db, groupId, await store.effectiveUserId(db, p.user_id));
    }
  }

  async function getExpenseWithSplits(db: ReturnType<typeof rootDb>, id: string) {
    const expense = await db
      .prepare('SELECT * FROM expenses WHERE id = ?')
      .bind(id)
      .first<store.ExpenseRow>();
    if (!expense) throw notFound('expense_not_found');
    const { results: splits } = await db
      .prepare('SELECT user_id, share_amount FROM expense_splits WHERE expense_id = ?')
      .bind(id)
      .all<{ user_id: string; share_amount: number }>();
    return { ...expense, splits };
  }

  async function getSettlement(db: ReturnType<typeof rootDb>, id: string) {
    const settlement = await db
      .prepare('SELECT * FROM settlements WHERE id = ?')
      .bind(id)
      .first<store.SettlementRow>();
    if (!settlement) throw notFound('settlement_not_found');
    return settlement;
  }

  /** currency -> { net, transfers, pairwise } via the shared engine. */
  async function groupBalances(db: ReturnType<typeof rootDb>, groupId: string) {
    const { results: expenseRows } = await db
      .prepare('SELECT * FROM expenses WHERE group_id = ? AND deleted_at IS NULL')
      .bind(groupId)
      .all<store.ExpenseRow>();
    const { results: settlementRows } = await db
      .prepare('SELECT * FROM settlements WHERE group_id = ?')
      .bind(groupId)
      .all<store.SettlementRow>();

    const byCurrency = new Map<
      string,
      { expenses: ExpenseRecord[]; settlements: SettlementRecord[] }
    >();
    const referencedIds = new Set<string>(await store.listMemberUserIds(db, groupId));
    const bucket = (currency: string) => {
      let entry = byCurrency.get(currency);
      if (!entry) {
        entry = { expenses: [], settlements: [] };
        byCurrency.set(currency, entry);
      }
      return entry;
    };

    for (const row of expenseRows) {
      const { results: splits } = await db
        .prepare('SELECT user_id, share_amount FROM expense_splits WHERE expense_id = ?')
        .bind(row.id)
        .all<{ user_id: string; share_amount: number }>();
      const splitMap: Record<string, number> = {};
      for (const s of splits) {
        splitMap[s.user_id] = s.share_amount;
        referencedIds.add(s.user_id);
      }
      referencedIds.add(row.paid_by);
      bucket(row.currency).expenses.push({
        id: row.id,
        paidBy: row.paid_by,
        amountTotal: row.amount_total,
        splits: splitMap,
      });
    }
    for (const row of settlementRows) {
      referencedIds.add(row.from_user).add(row.to_user);
      bucket(row.currency).settlements.push({
        id: row.id,
        from: row.from_user,
        to: row.to_user,
        amount: row.amount,
        status: row.status as SettlementRecord['status'],
      });
    }

    const users = await store.engineUsers(db, referencedIds);
    const result: Record<
      string,
      { net: Record<string, number>; transfers: unknown[]; pairwise: unknown[] }
    > = {};
    for (const [currency, data] of byCurrency) {
      const net = computeNetBalances(users, data.expenses, data.settlements);
      result[currency] = {
        net: Object.fromEntries(net),
        transfers: simplifyDebts(net),
        pairwise: computePairwiseDebts(users, data.expenses, data.settlements),
      };
    }
    return result;
  }

  return app;
}

function publicUser(user: store.UserRow) {
  return {
    id: user.id,
    display_name: user.display_name,
    default_upi_id: user.default_upi_id,
    is_ghost: user.is_ghost === 1,
    status: user.status,
    merged_into: user.merged_into,
  };
}
