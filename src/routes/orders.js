// src/routes/orders.js
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const mailer  = require('../utils/mailer');
const push    = require('../utils/push');
const router  = express.Router();

// ══════════════════════════════════════════════════════════════
// POST /api/orders  — შეკვეთის შექმნა + Escrow Hold
// ══════════════════════════════════════════════════════════════
router.post('/', requireAuth, async (req, res) => {
  try {
    const { listing_id } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'listing_id required' });

    const { rows: ls } = await db.query(
      "SELECT * FROM listings WHERE id=$1 AND status='active'", [listing_id]
    );
    if (!ls.length) return res.status(404).json({ error: 'listing_not_found' });
    const listing = ls[0];

    if (listing.seller_id === req.user.id)
      return res.status(400).json({ error: 'cannot_buy_own' });

    const { rows: u } = await db.query(
      'SELECT balance_gel FROM users WHERE id=$1', [req.user.id]
    );
    if (Number(u[0].balance_gel) < Number(listing.price_gel))
      return res.status(402).json({ error: 'insufficient_balance', needed: listing.price_gel });

    let order;
    await db.transaction(async (client) => {
      const fee      = Number(listing.price_gel) * 0.05;
      const receives = Number(listing.price_gel) - fee;

      const { rows: o } = await client.query(`
        INSERT INTO orders
          (listing_id,buyer_id,seller_id,amount_gel,platform_fee_pct,seller_receives,
           escrow_status,status,confirm_deadline)
        VALUES ($1,$2,$3,$4,5,$5,'held','active', NOW() + INTERVAL '48 hours')
        RETURNING *
      `, [listing_id, req.user.id, listing.seller_id, listing.price_gel, receives]);
      order = o[0];

      // ბალანსიდან Escrow-ში
      await client.query(
        'UPDATE users SET balance_gel=balance_gel-$1, escrow_hold_gel=escrow_hold_gel+$1 WHERE id=$2',
        [listing.price_gel, req.user.id]
      );
      // ტრანზაქცია
      await client.query(
        "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'escrow_hold',$3,'Escrow გაყინვა')",
        [req.user.id, order.id, -Number(listing.price_gel)]
      );
      // ჩათ ოთახი
      await client.query(
        'INSERT INTO chat_rooms(order_id,participant_a,participant_b) VALUES($1,$2,$3)',
        [order.id, req.user.id, listing.seller_id]
      );
      // listing orders_count
      await client.query(
        'UPDATE listings SET orders_count=orders_count+1 WHERE id=$1', [listing_id]
      );
    });

    res.status(201).json(order);

    // შეტყობ. გამყიდველს — async, response-ს არ აყოვნებს
    (async () => {
      try {
        const { rows: sellerRows } = await db.query(
          'SELECT id, email, notif_email FROM users WHERE id=$1', [listing.seller_id]
        );
        if (sellerRows.length) {
          await mailer.sendOrderCreatedEmail(sellerRows[0], order, listing);
        }
        await push.sendToUser(listing.seller_id, {
          title: '🛒 ახალი შეკვეთა',
          body: `${listing.title} — ₾${Number(order.amount_gel).toFixed(2)}`,
          url: `/?order=${order.id}`,
          tag: `order-${order.id}`,
        });
      } catch (e) { console.error('order notify error:', e.message); }
    })();
  } catch (err) {
    console.error('order create:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/orders/me  — საკუთარი შეკვეთები
// ══════════════════════════════════════════════════════════════
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT o.*,
        l.title AS listing_title, l.game, l.listing_type,
        b.username AS buyer_username, b.avatar_url AS buyer_avatar,
        s.username AS seller_username, s.avatar_url AS seller_avatar
      FROM orders o
      JOIN listings l ON l.id=o.listing_id
      JOIN users b ON b.id=o.buyer_id
      JOIN users s ON s.id=o.seller_id
      WHERE o.buyer_id=$1 OR o.seller_id=$1
      ORDER BY o.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/orders/:id
// ══════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT o.*,
        l.title AS listing_title, l.game, l.price_gel,
        b.username AS buyer_username,
        s.username AS seller_username
      FROM orders o
      JOIN listings l ON l.id=o.listing_id
      JOIN users b ON b.id=o.buyer_id
      JOIN users s ON s.id=o.seller_id
      WHERE o.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const order = rows[0];
    if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/orders/:id/confirm  — მყიდველი ადასტ. → Escrow Release
// ══════════════════════════════════════════════════════════════
router.post('/:id/confirm', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const order = rows[0];

    if (order.buyer_id !== req.user.id)
      return res.status(403).json({ error: 'only_buyer' });
    if (order.escrow_status !== 'held')
      return res.status(400).json({ error: 'not_in_escrow', current: order.escrow_status });

    await db.transaction(async (client) => {
      // მყიდველის escrow_hold შემცირება
      await client.query(
        'UPDATE users SET escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
        [order.amount_gel, order.buyer_id]
      );
      // გამყიდველს ჩარიცხვა (კომ. გამოკლებით)
      await client.query(
        'UPDATE users SET balance_gel=balance_gel+$1 WHERE id=$2',
        [order.seller_receives, order.seller_id]
      );
      // Order სტატუსი
      await client.query(`
        UPDATE orders SET
          escrow_status='released', status='completed',
          buyer_confirmed=TRUE, completed_at=NOW()
        WHERE id=$1
      `, [order.id]);
      // ტრანზაქციები
      await client.query(
        "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'sale_income',$3,'გაყიდვის შემოსავალი')",
        [order.seller_id, order.id, order.seller_receives]
      );
      await client.query(
        "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'platform_fee',$3,'პლატფ. კომ.')",
        [order.seller_id, order.id, -(order.amount_gel - order.seller_receives)]
      );
      // Listing → sold
      await client.query(
        "UPDATE listings SET status='sold' WHERE id=$1", [order.listing_id]
      );
    });

    res.json({ ok: true, show_review: true });

    // შეტყობ. გამყიდველს — ჩარიცხვა
    (async () => {
      try {
        const { rows: sellerRows } = await db.query(
          'SELECT id, email, notif_email FROM users WHERE id=$1', [order.seller_id]
        );
        const { rows: listingRows } = await db.query(
          'SELECT title FROM listings WHERE id=$1', [order.listing_id]
        );
        const listing = listingRows[0] || { title: 'განცხადება' };
        if (sellerRows.length) {
          await mailer.sendOrderConfirmedEmail(sellerRows[0], order, listing);
        }
        await push.sendToUser(order.seller_id, {
          title: '✅ შეკვეთა დადასტურდა',
          body: `${listing.title} — ₾${Number(order.seller_receives).toFixed(2)} ბალანსზე`,
          url: `/?page=wallet`,
          tag: `order-${order.id}-confirmed`,
        });
      } catch (e) { console.error('confirm notify error:', e.message); }
    })();
  } catch (err) {
    console.error('confirm:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/orders/:id/cancel  — გაუქმება + Refund
// ══════════════════════════════════════════════════════════════
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const order = rows[0];

    if (order.buyer_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });
    if (!['pending','active'].includes(order.status))
      return res.status(400).json({ error: 'cannot_cancel' });

    const { reason = '' } = req.body;

    await db.transaction(async (client) => {
      if (order.escrow_status === 'held') {
        await client.query(
          'UPDATE users SET balance_gel=balance_gel+$1, escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
          [order.amount_gel, order.buyer_id]
        );
        await client.query(
          "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'escrow_refund',$3,'გაუქმება/დაბრუნება')",
          [order.buyer_id, order.id, order.amount_gel]
        );
      }
      await client.query(`
        UPDATE orders SET escrow_status='refunded', status='cancelled',
          cancelled_at=NOW(), cancel_reason=$1 WHERE id=$2
      `, [reason, order.id]);
      await client.query(
        "UPDATE listings SET status='active' WHERE id=$1", [order.listing_id]
      );
    });

    res.json({ ok: true, refunded: order.amount_gel });

    // შეტყობ. მყიდველს — refund
    (async () => {
      try {
        const { rows: buyerRows } = await db.query(
          'SELECT id, email, notif_email FROM users WHERE id=$1', [order.buyer_id]
        );
        const { rows: listingRows } = await db.query(
          'SELECT title FROM listings WHERE id=$1', [order.listing_id]
        );
        const listing = listingRows[0] || { title: 'განცხადება' };
        if (buyerRows.length) {
          await mailer.sendOrderCancelledEmail(buyerRows[0], order, listing, reason);
        }
        await push.sendToUser(order.buyer_id, {
          title: '↩️ შეკვეთა გაუქმდა',
          body: `${listing.title} — ₾${Number(order.amount_gel).toFixed(2)} დაბრუნდა`,
          url: `/?page=wallet`,
          tag: `order-${order.id}-cancelled`,
        });
      } catch (e) { console.error('cancel notify error:', e.message); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
