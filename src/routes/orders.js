// src/routes/orders.js
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const mailer  = require('../utils/mailer');
const push    = require('../utils/push');
const ledger  = require('../utils/ledger');
const chat    = require('./chat');
const router  = express.Router();

// 48სთ hold-ის scheduler-ი — ერთხელ, მოდულის პირველ ჩატვირთვაზე
ledger.startHoldsScheduler();

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
           escrow_status,status)
        VALUES ($1,$2,$3,$4,5,$5,'held','active')
        RETURNING *
      `, [listing_id, req.user.id, listing.seller_id, listing.price_gel, receives]);
      order = o[0];

      // ბალანსიდან Escrow-ში
      await client.query(
        'UPDATE users SET balance_gel=balance_gel-$1, escrow_hold_gel=escrow_hold_gel+$1 WHERE id=$2',
        [listing.price_gel, req.user.id]
      );
      await client.query(
        "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'escrow_hold',$3,'Escrow გაყინვა')",
        [req.user.id, order.id, -Number(listing.price_gel)]
      );
      // ჩათ ოთახი
      await client.query(
        'INSERT INTO chat_rooms(order_id,participant_a,participant_b) VALUES($1,$2,$3)',
        [order.id, req.user.id, listing.seller_id]
      );
      await client.query(
        'UPDATE listings SET orders_count=orders_count+1 WHERE id=$1', [listing_id]
      );
    });

    res.status(201).json(order);

    // შეტყობ. გამყიდველს
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
// POST /api/orders/:id/deliver  — გამყიდველი: „მონაცემები გადავეცი"
// სტატუსი: active → delivered | ირთვება 48სთ countdown
// ══════════════════════════════════════════════════════════════
router.post('/:id/deliver', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const order = rows[0];

    if (order.seller_id !== req.user.id)
      return res.status(403).json({ error: 'only_seller' });
    if (order.status !== 'active')
      return res.status(400).json({ error: 'cannot_deliver', current: order.status });
    if (order.escrow_status !== 'held')
      return res.status(400).json({ error: 'escrow_not_held' });

    // delivered_at → confirm_deadline = delivered_at + 48სთ
    const deliveredAt = new Date();
    const deadline    = new Date(deliveredAt.getTime() + 48 * 60 * 60 * 1000);

    await db.query(`
      UPDATE orders SET
        status             = 'delivered',
        delivered_at       = $1,
        confirm_deadline   = $2,
        reminder_24h_sent  = FALSE,
        updated_at         = NOW()
      WHERE id = $3
    `, [deliveredAt, deadline, order.id]);

    const updated = { ...order, status: 'delivered', delivered_at: deliveredAt, confirm_deadline: deadline };
    res.json({ ok: true, order: updated });

    // შეტყობ. მყიდველს — ნივთი გადაეცა, 48სთ დარჩა
    (async () => {
      try {
        const { rows: listingRows } = await db.query('SELECT title FROM listings WHERE id=$1', [order.listing_id]);
        const listing = listingRows[0] || { title: 'განცხადება' };
        const { rows: buyerRows } = await db.query('SELECT id, email, notif_email FROM users WHERE id=$1', [order.buyer_id]);

        // ჩატში სისტემური შეტყობინება
        const { rows: roomRows } = await db.query('SELECT id FROM chat_rooms WHERE order_id=$1', [order.id]);
        if (roomRows.length) {
          const { rows: msgRows } = await db.query(`
            INSERT INTO messages(room_id, sender_id, content, content_type)
            VALUES($1, $2, $3, 'system')
            RETURNING *
          `, [roomRows[0].id, order.seller_id,
              `✅ გამყიდველმა ნივთი/მონაცემები გადასცა. თქვენ გაქვთ 48 საათი შეამოწმოთ და დაადასტუროთ (ვადა: ${deadline.toLocaleString('ka-GE')}). თუ პრობლემაა — გახსენით დავა.`]);
          chat.broadcastMessageToRoom(roomRows[0].id, msgRows[0]);
        }

        if (buyerRows.length) {
          await mailer.sendDeliveredEmail(buyerRows[0], order, listing, deadline);
        }
        await push.sendToUser(order.buyer_id, {
          title: '📦 ნივთი გადაგეცათ',
          body: `${listing.title} — 48სთ-ში დაადასტ. ან გახსენი დავა`,
          url: `/?order=${order.id}`,
          tag: `order-${order.id}-delivered`,
        });
      } catch (e) { console.error('deliver notify error:', e.message); }
    })();
  } catch (err) {
    console.error('deliver:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/orders/me  — საკუთარი შეკვეთები (profile mini-list)
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
      LIMIT 10
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/orders/history  — სრული ისტ. + ფილტრი + pagination
// ══════════════════════════════════════════════════════════════
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const params = [req.user.id, req.user.id];
    let statusClause = '';
    if (status) {
      statusClause = `AND o.status = $3`;
      params.push(status);
    }

    const { rows } = await db.query(`
      SELECT
        o.*,
        l.title AS listing_title, l.game, l.category,
        b.username AS buyer_username, b.avatar_url AS buyer_avatar,
        s.username AS seller_username, s.avatar_url AS seller_avatar,
        cr.id AS chat_room_id,
        d.id AS dispute_id, d.reason AS dispute_reason,
        d.status AS dispute_status, d.resolution AS dispute_resolution,
        d.created_at AS dispute_created_at, d.resolved_at AS dispute_resolved_at,
        d.evidence_urls AS dispute_evidence_urls,
        r.id AS review_id, r.rating AS review_rating, r.comment AS review_comment
      FROM orders o
      JOIN listings l ON l.id=o.listing_id
      JOIN users b ON b.id=o.buyer_id
      JOIN users s ON s.id=o.seller_id
      LEFT JOIN chat_rooms cr ON cr.order_id=o.id
      LEFT JOIN disputes d ON d.order_id=o.id
      LEFT JOIN reviews r ON r.order_id=o.id
      WHERE (o.buyer_id=$1 OR o.seller_id=$2)
      ${statusClause}
      ORDER BY o.updated_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, Number(limit), offset]);

    const { rows: cnt } = await db.query(`
      SELECT COUNT(*) FROM orders o
      WHERE (o.buyer_id=$1 OR o.seller_id=$2)
      ${statusClause}
    `, params);

    const total      = Number(cnt[0].count);
    const totalPages = Math.ceil(total / Number(limit));

    res.json({ orders: rows, total, page: Number(page), total_pages: totalPages });
  } catch (err) {
    console.error('orders history:', err.message);
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
        s.username AS seller_username,
        cr.id AS chat_room_id,
        d.id AS dispute_id, d.status AS dispute_status
      FROM orders o
      JOIN listings l ON l.id=o.listing_id
      JOIN users b ON b.id=o.buyer_id
      JOIN users s ON s.id=o.seller_id
      LEFT JOIN chat_rooms cr ON cr.order_id=o.id
      LEFT JOIN disputes d ON d.order_id=o.id
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
    // status უნდა იყოს active ან delivered
    if (!['active', 'delivered'].includes(order.status))
      return res.status(400).json({ error: 'cannot_confirm', current: order.status });

    let holdUntil;
    await db.transaction(async (client) => {
      await client.query(
        'UPDATE users SET escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
        [order.amount_gel, order.buyer_id]
      );

      // გამყიდველის შემოსავალი — 48სთ hold-ში (ანტი-ფროდ დაცვა), არა პირდაპირ balance_gel-ზე
      const fee = Number(order.amount_gel) - Number(order.seller_receives);
      holdUntil = await ledger.creditSellerWithHold(client, {
        sellerId:  order.seller_id,
        orderId:   order.id,
        amountGel: order.seller_receives,
        source:    'order_confirm',
      });
      // საიტის 5%-იანი საკომისიო → admin_earnings
      await ledger.recordPlatformFee(client, fee);

      await client.query(`
        UPDATE orders SET
          escrow_status='released', status='completed',
          buyer_confirmed=TRUE, completed_at=NOW(), updated_at=NOW()
        WHERE id=$1
      `, [order.id]);
      await client.query(
        "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'sale_income',$3,'გაყიდვის შემოსავალი (48სთ hold)')",
        [order.seller_id, order.id, order.seller_receives]
      );
      await client.query(
        "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'platform_fee',$3,'პლატფ. კომ.')",
        [order.seller_id, order.id, -fee]
      );
      await client.query("UPDATE listings SET status='sold' WHERE id=$1", [order.listing_id]);
    });

    res.json({ ok: true, show_review: true, hold_until: holdUntil });

    (async () => {
      try {
        const { rows: sellerRows } = await db.query(
          'SELECT id, email, notif_email FROM users WHERE id=$1', [order.seller_id]
        );
        const { rows: listingRows } = await db.query('SELECT title FROM listings WHERE id=$1', [order.listing_id]);
        const listing = listingRows[0] || { title: 'განცხადება' };
        if (sellerRows.length) {
          await mailer.sendOrderConfirmedEmail(sellerRows[0], order, listing);
        }
        await push.sendToUser(order.seller_id, {
          title: '✅ შეკვეთა დადასტ.',
          body: `${listing.title} — ₾${Number(order.seller_receives).toFixed(2)} 48სთ hold-ში`,
          url: `/?page=wallet`,
          tag: `order-${order.id}-confirmed`,
        });

        // ჩატში ავტ. სისტემური შეტყობინება + რეალურ დროში გავრცელება
        const { rows: roomRows } = await db.query('SELECT id FROM chat_rooms WHERE order_id=$1', [order.id]);
        if (roomRows.length) {
          const roomId = roomRows[0].id;
          const { rows: msgRows } = await db.query(`
            INSERT INTO messages(room_id, sender_id, content, content_type)
            VALUES($1, $2, '✅ ყიდვა დადასტურდა — თანხა გამყიდველს 48-საათიანი hold-ით ჩაერიცხა.', 'system')
            RETURNING *
          `, [roomId, req.user.id]);
          chat.broadcastMessageToRoom(roomId, msgRows[0]);
          // listing-ი მყისიერად "sold"-ად აღინიშნება ორივე მხარის ღია გვერდებზე
          chat.broadcastEventToRoom(roomId, {
            event: 'confirmed', status: 'sold',
            order_id: order.id, listing_id: order.listing_id,
          });
        }
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
          "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'escrow_refund',$3,'გაუქმება/დაბრ.')",
          [order.buyer_id, order.id, order.amount_gel]
        );
      }
      await client.query(`
        UPDATE orders SET escrow_status='refunded', status='cancelled',
          cancelled_at=NOW(), cancel_reason=$1, updated_at=NOW() WHERE id=$2
      `, [reason, order.id]);
      await client.query("UPDATE listings SET status='active' WHERE id=$1", [order.listing_id]);
    });

    res.json({ ok: true, refunded: order.amount_gel });

    (async () => {
      try {
        const { rows: buyerRows } = await db.query(
          'SELECT id, email, notif_email FROM users WHERE id=$1', [order.buyer_id]
        );
        const { rows: listingRows } = await db.query('SELECT title FROM listings WHERE id=$1', [order.listing_id]);
        const listing = listingRows[0] || { title: 'განცხადება' };
        if (buyerRows.length) {
          await mailer.sendOrderCancelledEmail(buyerRows[0], order, listing, reason);
        }
        await push.sendToUser(order.buyer_id, {
          title: '↩️ შეკვეთა გაუქმდა',
          body: `${listing.title} — ₾${Number(order.amount_gel).toFixed(2)} დაბრ.`,
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
