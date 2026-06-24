// src/routes/admin.js
// Admin Panel API — dispute resolve, user ban, listings moderation
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const mailer  = require('../utils/mailer');
const push    = require('../utils/push');
const router  = express.Router();

// ყველა route მოითხოვს admin როლს
router.use(requireAuth, requireAdmin);

// ══════════════════════════════════════════════════════════════
// GET /api/admin/overview  — dashboard სტატისტიკა
// ══════════════════════════════════════════════════════════════
router.get('/overview', async (req, res) => {
  try {
    const [users, listings, orders, disputes, volume] = await Promise.all([\
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE role='banned') AS banned FROM users"),
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status='active') AS active, COUNT(*) FILTER (WHERE status='pending') AS pending FROM listings"),
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status='active') AS active, COUNT(*) FILTER (WHERE status='completed') AS completed FROM orders"),
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status='open') AS open FROM disputes"),
      db.query("SELECT COALESCE(SUM(amount_gel),0) AS total FROM orders WHERE status='completed'"),
    ]);

    res.json({
      users: { total: Number(users.rows[0].n), banned: Number(users.rows[0].banned) },
      listings: { total: Number(listings.rows[0].n), active: Number(listings.rows[0].active), pending: Number(listings.rows[0].pending) },
      orders: {
        total: Number(orders.rows[0].n),
        active: Number(orders.rows[0].active),
        completed: Number(orders.rows[0].completed),
      },
      disputes: { total: Number(disputes.rows[0].n), open: Number(disputes.rows[0].open) },
      volume_gel: Number(volume.rows[0].total),
    });
  } catch (err) {
    console.error('admin overview error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/disputes  — დავების სია (ფილტრით სტატუსზე)
// ══════════════════════════════════════════════════════════════
router.get('/disputes', async (req, res) => {
  try {
    const { status = 'open', page = 1, limit = 30 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const conditions = [];
    const params = [];
    let p = 1;
    if (status && status !== 'all') {
      conditions.push(`d.status = $${p++}`);
      params.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Number(limit), offset);

    const { rows } = await db.query(`
      SELECT d.*,
        o.amount_gel, o.status AS order_status, o.escrow_status,
        l.title AS listing_title, l.game,
        ob.username AS buyer_username, ob.id AS buyer_id,
        os.username AS seller_username, os.id AS seller_id,
        oc.username AS opened_by_username
      FROM disputes d
      JOIN orders o   ON o.id = d.order_id
      JOIN listings l ON l.id = o.listing_id
      JOIN users ob   ON ob.id = o.buyer_id
      JOIN users os   ON os.id = o.seller_id
      JOIN users oc   ON oc.id = d.opened_by
      ${where}
      ORDER BY d.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('admin disputes list error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/admin/disputes/:id/resolve  — დავის გადაწყვეტა
// ══════════════════════════════════════════════════════════════
router.put('/disputes/:id/resolve', async (req, res) => {
  try {
    const { resolution, admin_note } = req.body;
    if (!['release', 'refund'].includes(resolution))
      return res.status(400).json({ error: 'resolution must be release or refund' });

    const { rows: d } = await db.query('SELECT * FROM disputes WHERE id=$1', [req.params.id]);
    if (!d.length) return res.status(404).json({ error: 'not_found' });
    if (d[0].status === 'resolved') return res.status(409).json({ error: 'already_resolved' });

    const { rows: o } = await db.query('SELECT * FROM orders WHERE id=$1', [d[0].order_id]);
    if (!o.length) return res.status(404).json({ error: 'order_not_found' });
    const order = o[0];

    await db.transaction(async (client) => {
      if (resolution === 'release') {
        await client.query(
          'UPDATE users SET balance_gel=balance_gel+$1 WHERE id=$2',
          [order.seller_receives, order.seller_id]
        );
        await client.query(
          'UPDATE users SET escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
          [order.amount_gel, order.buyer_id]
        );
        await client.query(
          "UPDATE orders SET escrow_status='released',status='completed',completed_at=NOW() WHERE id=$1",
          [order.id]
        );
        await client.query(
          "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'sale_income',$3,'დავის გადაწყვ. — გამყ-ზე გადახდა')",
          [order.seller_id, order.id, order.seller_receives]
        );
      } else {
        await client.query(
          'UPDATE users SET balance_gel=balance_gel+$1, escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
          [order.amount_gel, order.buyer_id]
        );
        await client.query(
          "UPDATE orders SET escrow_status='refunded',status='cancelled',cancelled_at=NOW() WHERE id=$1",
          [order.id]
        );
        await client.query(
          "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'escrow_refund',$3,'დავის გადაწყვ. — მყიდვ-ს დაბრუნება')",
          [order.buyer_id, order.id, order.amount_gel]
        );
      }
      await client.query(`
        UPDATE disputes SET
          status='resolved', resolution=$1, admin_note=$2,
          resolved_by=$3, resolved_at=NOW()
        WHERE id=$4
      `, [resolution, admin_note || '', req.user.id, req.params.id]);
    });

    res.json({ ok: true, resolution });

    // შეტყობ. — მყიდველი + გამყიდველი
    (async () => {
      try {
        const { rows: listingRows } = await db.query('SELECT title FROM listings WHERE id=$1', [order.listing_id]);
        const listing = listingRows[0] || { title: 'განცხადება' };
        const dispute = { ...d[0], resolution, admin_note: admin_note || '' };

        const { rows: parties } = await db.query(
          'SELECT id, email, notif_email FROM users WHERE id=$1 OR id=$2',
          [order.buyer_id, order.seller_id]
        );
        for (const recipient of parties) {
          await mailer.sendDisputeResolvedEmail(recipient, dispute, order, listing, resolution);
          await push.sendToUser(recipient.id, {
            title: '🛡️ დავა გადაწყდა',
            body: `${listing.title} — ${resolution === 'release' ? 'თანხა გამყიდველს' : 'თანხა მყიდველს'}`,
            url: `/?order=${order.id}`,
            tag: `dispute-${dispute.id}-resolved`,
          });
        }
      } catch (e) { console.error('admin dispute resolve notify error:', e.message); }
    })();
  } catch (err) {
    console.error('admin dispute resolve error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/users  — მომხმარებლების სია (ძებნა + ფილტრი)
// ══════════════════════════════════════════════════════════════
router.get('/users', async (req, res) => {
  try {
    const { search, role, page = 1, limit = 30 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const conditions = [];
    const params = [];
    let p = 1;

    if (search) {
      conditions.push(`(username ILIKE $${p} OR email ILIKE $${p} OR display_name ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }
    if (role && role !== 'all') {
      conditions.push(`role = $${p++}`);
      params.push(role);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Number(limit), offset);

    const { rows } = await db.query(`
      SELECT id, email, username, display_name, avatar_url, role,
             is_verified_seller, balance_gel, escrow_hold_gel,
             auth_provider, email_verified, created_at, last_seen_at
      FROM users
      ${where}
      ORDER BY created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `, params);

    const { rows: cnt } = await db.query(
      `SELECT COUNT(*) FROM users ${where}`,
      params.slice(0, params.length - 2)
    );

    res.json({ users: rows, total: Number(cnt[0].count), page: Number(page), pages: Math.ceil(Number(cnt[0].count) / Number(limit)) });
  } catch (err) {
    console.error('admin users list error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/admin/users/:id/ban
// ══════════════════════════════════════════════════════════════
router.put('/users/:id/ban', async (req, res) => {
  try {
    const { rows: target } = await db.query('SELECT id, role FROM users WHERE id=$1', [req.params.id]);
    if (!target.length) return res.status(404).json({ error: 'not_found' });
    if (target[0].role === 'admin') return res.status(400).json({ error: 'cannot_ban_admin' });
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'cannot_ban_self' });

    await db.query("UPDATE users SET role='banned', updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/admin/users/:id/unban
// ══════════════════════════════════════════════════════════════
router.put('/users/:id/unban', async (req, res) => {
  try {
    const { rows: target } = await db.query('SELECT id, role FROM users WHERE id=$1', [req.params.id]);
    if (!target.length) return res.status(404).json({ error: 'not_found' });
    if (target[0].role !== 'banned') return res.status(400).json({ error: 'not_banned' });

    await db.query("UPDATE users SET role='user', updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/listings  — განცხ. სია (ძებნა + ფილტრი სტატუსით)
// ══════════════════════════════════════════════════════════════
router.get('/listings', async (req, res) => {
  try {
    const { search, status, page = 1, limit = 30 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const conditions = [];
    const params = [];
    let p = 1;

    if (search) {
      conditions.push(`(l.title ILIKE $${p} OR l.game ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }
    if (status && status !== 'all') {
      conditions.push(`l.status = $${p++}`);
      params.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Number(limit), offset);

    const { rows } = await db.query(`
      SELECT l.*, u.username AS seller_username, u.email AS seller_email
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `, params);

    const { rows: cnt } = await db.query(
      `SELECT COUNT(*) FROM listings l ${where}`,
      params.slice(0, params.length - 2)
    );

    res.json({ listings: rows, total: Number(cnt[0].count), page: Number(page), pages: Math.ceil(Number(cnt[0].count) / Number(limit)) });
  } catch (err) {
    console.error('admin listings list error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/admin/listings/:id/moderate  — status შეცვლა (active/blocked/...)
// ══════════════════════════════════════════════════════════════
router.put('/listings/:id/moderate', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'blocked', 'pending', 'sold', 'deleted'].includes(status))
      return res.status(400).json({ error: 'invalid_status' });

    const { rows } = await db.query(
      'UPDATE listings SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// DELETE /api/admin/listings/:id  — soft delete
// ══════════════════════════════════════════════════════════════
router.delete('/listings/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      "UPDATE listings SET status='deleted', updated_at=NOW() WHERE id=$1 RETURNING id",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
