// src/routes/wallet.js
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// ══════════════════════════════════════════════════════════════
// GET /api/wallet/balance
// ══════════════════════════════════════════════════════════════
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT balance_gel, balance_usd, escrow_hold_gel, balance_available_at FROM users WHERE id=$1',
      [req.user.id]
    );
    const b    = rows[0];
    const rate = 2.74;
    const now  = new Date();

    // hold პერიოდი: balance_available_at > NOW() → ბალანსი გაყინული
    const holdUntil     = b.balance_available_at ? new Date(b.balance_available_at) : null;
    const isOnHold      = holdUntil && holdUntil > now;
    const holdSecondsLeft = isOnHold ? Math.ceil((holdUntil - now) / 1000) : 0;

    res.json({
      balance_gel:        Number(b.balance_gel),
      balance_usd:        Number(b.balance_usd),
      escrow_hold_gel:    Number(b.escrow_hold_gel),
      available_gel:      Number(b.balance_gel),
      exchange_rate:      rate,
      available_usd:      +(Number(b.balance_gel) / rate).toFixed(2),
      // Hold info — frontend-ი ამ ველებს იყენებს countdown-ისთვის
      balance_available_at: b.balance_available_at || null,
      withdraw_on_hold:     isOnHold,
      withdraw_hold_seconds_left: holdSecondsLeft,
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
// POST /api/wallet/deposit  — შეტანის მოთხოვნა
// ══════════════════════════════════════════════════════════════
router.post('/deposit', requireAuth, async (req, res) => {
  try {
    const { amount, method = 'BOG' } = req.body;
    if (!amount || Number(amount) < 1)
      return res.status(400).json({ error: 'min_1_gel' });
    if (Number(amount) > 5000)
      return res.status(400).json({ error: 'max_5000_gel' });

    const ref = `DEP-${Date.now()}-${req.user.id.slice(0,8)}`;
    await db.query(
      "INSERT INTO transactions(user_id,type,amount_gel,status,payment_method,external_ref,description) VALUES($1,'deposit',$2,'pending',$3,$4,'ბალანსის შეტანა')",
      [req.user.id, Number(amount), method, ref]
    );

    const payUrl = process.env.NODE_ENV === 'production'
      ? `https://checkout.bog.ge/pay?ref=${ref}&amount=${amount}`
      : `http://localhost:${process.env.PORT}/api/wallet/deposit/simulate?ref=${ref}&amount=${amount}`;

    res.json({ ref, pay_url: payUrl, amount, method });
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
      'SELECT balance_gel, balance_available_at FROM users WHERE id=$1', [req.user.id]
    );
    const b = rows[0];

    // ── 24სთ Hold შემოწმება ──────────────────────────────────
    const now       = new Date();
    const holdUntil = b.balance_available_at ? new Date(b.balance_available_at) : null;
    if (holdUntil && holdUntil > now) {
      const secsLeft = Math.ceil((holdUntil - now) / 1000);
      const hoursLeft = (secsLeft / 3600).toFixed(1);
      return res.status(403).json({
        error: 'balance_on_hold',
        message: `ბალანსი ${hoursLeft} საათით დაბლოკილია (ანტი-ფროდ დაცვა)`,
        available_at: holdUntil.toISOString(),
        seconds_left: secsLeft,
      });
    }

    const commission = +(Number(amount) * 0.02).toFixed(2);
    const total      = Number(amount) + commission;

    if (Number(b.balance_gel) < total)
      return res.status(402).json({ error: 'insufficient_balance', available: b.balance_gel });

    await db.transaction(async (client) => {
      await client.query(
        'UPDATE users SET balance_gel=balance_gel-$1 WHERE id=$2', [total, req.user.id]
      );
      await client.query(
        "INSERT INTO transactions(user_id,type,amount_gel,status,payment_method,description) VALUES($1,'withdrawal',$2,'pending','bank',$3)",
        [req.user.id, -total, `გამოტ. IBAN: ${iban.slice(-4)} · კომ: ₾${commission}`]
      );
    });

    res.json({ ok: true, amount, commission, total, eta: '1-2 სამ. დღე' });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
