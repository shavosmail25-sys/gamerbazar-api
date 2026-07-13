// src/routes/wallet.js
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const mailer  = require('../utils/mailer');
const ledger  = require('../utils/ledger');

const ADMIN_EMAIL = process.env.EMAIL_USER || process.env.SMTP_USER || 'shavosmail25@gmail.com';
const router  = express.Router();

// ── NO-CACHE — ბალანსი/ტრანზაქციები ხშირად იცვლება; ვუკრძალავთ
// ბრაუზერს/პროქსის ამ პასუხების დაკეშვას.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ══════════════════════════════════════════════════════════════
// GET /api/wallet/balance
// ══════════════════════════════════════════════════════════════
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT balance_gel, balance_usd, escrow_hold_gel, hold_balance_gel FROM users WHERE id=$1',
      [req.user.id]
    );
    const b    = rows[0];
    const rate = 2.74;

    // უახლოესი hold-ის ვადა — countdown-ისთვის (48სთ ტაიმერი)
    const { rows: nextHoldRows } = await db.query(
      `SELECT hold_until, amount_gel FROM balance_holds
       WHERE user_id=$1 AND released=FALSE
       ORDER BY hold_until ASC LIMIT 1`,
      [req.user.id]
    );
    const nextHold = nextHoldRows[0] || null;
    const now = new Date();
    const holdSecondsLeft = nextHold
      ? Math.max(0, Math.ceil((new Date(nextHold.hold_until) - now) / 1000))
      : 0;

    res.json({
      balance_gel:        Number(b.balance_gel),
      balance_usd:        Number(b.balance_usd),
      escrow_hold_gel:    Number(b.escrow_hold_gel),
      hold_balance_gel:   Number(b.hold_balance_gel),
      available_gel:      Number(b.balance_gel),
      exchange_rate:      rate,
      available_usd:      +(Number(b.balance_gel) / rate).toFixed(2),
      // 48-საათიანი hold — უახლოესი გათავისუფლების დრო, frontend countdown-ისთვის
      next_hold_release_at:      nextHold ? nextHold.hold_until : null,
      next_hold_amount_gel:      nextHold ? Number(nextHold.amount_gel) : 0,
      hold_seconds_left:         holdSecondsLeft,
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/wallet/transactions  — ტრანზ. ისტ.
// ══════════════════════════════════════════════════════════════
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const { rows } = await db.query(`
      SELECT t.*, o.listing_id,
        CASE WHEN l.title IS NOT NULL THEN l.title ELSE NULL END AS listing_title
      FROM transactions t
      LEFT JOIN orders o ON o.id = t.order_id
      LEFT JOIN listings l ON l.id = o.listing_id
      WHERE t.user_id=$1
      ORDER BY t.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.id, Number(limit), offset]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// POST /api/wallet/deposit  — შეტანის მოთხოვნა (Manual BOG)
// ══════════════════════════════════════════════════════════════
router.post('/deposit', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || Number(amount) < 1)
      return res.status(400).json({ error: 'min_1_gel' });
    if (Number(amount) > 10000)
      return res.status(400).json({ error: 'max_10000_gel' });

    const ref = `GB-${Date.now().toString(36).toUpperCase()}-${req.user.id.slice(0,6).toUpperCase()}`;

    await db.query(
      `INSERT INTO transactions(user_id,type,amount_gel,status,payment_method,external_ref,description)
       VALUES($1,'deposit',$2,'pending','BOG',$3,'ბალანსის შეტანა — BOG გადარიცხვა')`,
      [req.user.id, Number(amount), ref]
    );

    res.json({
      ref,
      amount: Number(amount),
      iban:        'GE62BG0000000562150681',
      recipient:   'Jumber Shavadze',
      bank:        'Bank of Georgia',
      description: ref,
      eta_hours:   24,
    });

    // ადმინს email — async
    (async () => {
      try {
        await mailer.sendDepositRequestEmail(ADMIN_EMAIL, req.user, amount, ref);
      } catch(e) { console.error('deposit email:', e.message); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/wallet/deposit/simulate  — DEV ტესტი
// ══════════════════════════════════════════════════════════════
router.get('/deposit/simulate', requireAuth, async (req, res) => {
  if (process.env.NODE_ENV === 'production')
    return res.status(404).json({ error: 'not_found' });

  try {
    const { ref, amount } = req.query;
    await db.transaction(async (client) => {
      await client.query(
        "UPDATE transactions SET status='completed' WHERE external_ref=$1", [ref]
      );
      await client.query(
        'UPDATE users SET balance_gel=balance_gel+$1 WHERE id=$2',
        [Number(amount), req.user.id]
      );
    });
    res.json({ ok: true, message: `₾${amount} ბალანსზე დაემატა (სიმულ.)` });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/wallet/withdraw  — გამოტ. მოთხოვნა
// ══════════════════════════════════════════════════════════════
router.post('/withdraw', requireAuth, async (req, res) => {
  try {
    const { amount, iban } = req.body;
    if (!amount || !iban)
      return res.status(400).json({ error: 'amount and iban required' });
    if (Number(amount) < 5)
      return res.status(400).json({ error: 'min_5_gel' });

    const { rows } = await db.query(
      'SELECT balance_gel, hold_balance_gel FROM users WHERE id=$1', [req.user.id]
    );
    const b = rows[0];

    // შენიშვნა: 48სთ hold-ის თანხა hold_balance_gel-შია, არა balance_gel-ში —
    // ანუ balance_gel უკვე მხოლოდ თავისუფლად გასატან თანხას ასახავს, დამატებითი
    // ბლოკირება საჭირო აღარაა (იხ. src/utils/ledger.js).

    // გლობალური 5%-იანი საკომისიო (ledger.js) — ბალანსიდან იკლება ზუსტად
    // მოთხოვნილი თანხა (gross), ხოლო ადმინმა ხელზე უნდა გასცეს მხოლოდ
    // net (95%) — fee ჩაითვლება პლატფორმის შემოსავალში მხოლოდ მას შემდეგ,
    // რაც ადმინი მოთხოვნას რეალურად დაადასტურებს (admin.js /confirm).
    const { gross, fee, net } = ledger.splitCommission(amount);

    if (Number(b.balance_gel) < gross)
      return res.status(402).json({ error: 'insufficient_balance', available: b.balance_gel });

    await db.transaction(async (client) => {
      await client.query(
        'UPDATE users SET balance_gel=balance_gel-$1 WHERE id=$2', [gross, req.user.id]
      );
      await client.query(
        `INSERT INTO transactions
           (user_id,type,amount_gel,gross_amount_gel,net_amount_gel,commission_fee_gel,status,payment_method,description)
         VALUES($1,'withdrawal',$2,$3,$4,$5,'pending','bank',$6)`,
        [req.user.id, -gross, gross, net, fee,
         `გამოტ. IBAN: ${iban.slice(-4)} · ხელზე გაცემა: ₾${net} (საკომ. 5% — ₾${fee})`]
      );
    });

    res.json({ ok: true, amount: gross, commission: fee, net_payout: net, eta: '1-2 სამ. დღე' });

    // ადმინს email — async
    (async () => {
      try {
        await mailer.sendWithdrawRequestEmail(ADMIN_EMAIL, req.user, amount, iban);
      } catch(e) { console.error('withdraw email:', e.message); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
