// src/routes/listings.js
// განცხადებების API

'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ══════════════════════════════════════════════════════════════
// GET /api/listings  — სია (ფილტრი + pagination)
// ══════════════════════════════════════════════════════════════
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      category, game, listing_type, vip,
      min_price, max_price,
      search, sort = 'newest',
      page = 1, limit = 20,
      seller_id,
      include_sold
    } = req.query;

    // პროფ. გვ-ზე seller_id-ით ვფილტრავთ — status-ს გავაფართოვოთ
    const statusFilter = seller_id
      ? (include_sold === 'true'
          ? "l.status IN ('active','sold')"
          : "l.status IN ('active','sold','pending')")
      : "l.status = 'active'";

    const conditions = [statusFilter];
    const params     = [];
    let   p          = 1;

    if (seller_id)    { conditions.push(`l.seller_id = $${p++}`);      params.push(seller_id); }
    if (category)     { conditions.push(`l.category = $${p++}`);       params.push(category); }
    if (game)         { conditions.push(`l.game ILIKE $${p++}`);        params.push(`%${game}%`); }
    if (listing_type) { conditions.push(`l.listing_type = $${p++}`);    params.push(listing_type); }
    if (vip === 'true') {
      conditions.push(`l.is_vip = TRUE AND (l.vip_expires_at IS NULL OR l.vip_expires_at > NOW())`);
    }
    if (min_price)    { conditions.push(`l.price_gel >= $${p++}`);      params.push(min_price); }
    if (max_price)    { conditions.push(`l.price_gel <= $${p++}`);      params.push(max_price); }
    if (search)       {
      conditions.push(`(l.title ILIKE $${p} OR l.description ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }

    const where = conditions.join(' AND ');

    const sortMap = {
      newest:    'l.created_at DESC',
      oldest:    'l.created_at ASC',
      price_asc: 'l.price_gel ASC',
      price_desc:'l.price_gel DESC',
      rating:    'ss.avg_rating DESC NULLS LAST',
    };
    const orderBy = sortMap[sort] || 'l.created_at DESC';

    // VIP ყოველთვის პირველი
    const fullOrder = `l.is_vip DESC, ${orderBy}`;

    const offset = (Number(page) - 1) * Number(limit);
    params.push(Number(limit), offset);

    const { rows } = await db.query(`
      SELECT
        l.*,
        ROUND(l.price_gel * 0.365, 2) AS price_usd,
        u.username     AS seller_username,
        u.display_name AS seller_name,
        u.avatar_url   AS seller_avatar,
        u.is_verified_seller,
        COALESCE(ss.avg_rating, 0)      AS seller_rating,
        COALESCE(ss.review_count, 0)    AS seller_review_count,
        COALESCE(ss.completed_orders, 0)AS seller_completed
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      LEFT JOIN seller_stats ss ON ss.seller_id = l.seller_id
      WHERE ${where}
      ORDER BY ${fullOrder}
      LIMIT $${p++} OFFSET $${p++}
    `, params);

    // სულ რაოდენობა pagination-ისთვის
    const { rows: cnt } = await db.query(
      `SELECT COUNT(*) FROM listings l WHERE ${where}`,
      params.slice(0, params.length - 2)
    );

    res.json({
      listings: rows,
      total:    Number(cnt[0].count),
      page:     Number(page),
      pages:    Math.ceil(Number(cnt[0].count) / Number(limit)),
    });
  } catch (err) {
    console.error('listings GET error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/listings/:id  — ერთი განცხადება
// ══════════════════════════════════════════════════════════════
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        l.*,
        ROUND(l.price_gel * 0.365, 2) AS price_usd,
        u.username, u.display_name, u.avatar_url, u.is_verified_seller,
        COALESCE(ss.avg_rating, 0)   AS seller_rating,
        COALESCE(ss.review_count, 0) AS seller_review_count,
        COALESCE(ss.completed_orders,0) AS seller_completed
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      LEFT JOIN seller_stats ss ON ss.seller_id = l.seller_id
      WHERE l.id = $1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    // ნახვათა რიცხვი
    await db.query('UPDATE listings SET views_count = views_count + 1 WHERE id=$1', [req.params.id]);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/listings  — განცხადების შექმნა
// ══════════════════════════════════════════════════════════════
router.post('/', requireAuth, async (req, res) => {
  try {
    const { category, game, listing_type, title, description, tags, price_gel } = req.body;

    if (!category || !game || !listing_type || !title || !price_gel) {
      return res.status(400).json({ error: 'required_fields' });
    }
    if (Number(price_gel) <= 0 || Number(price_gel) > 50000) {
      return res.status(400).json({ error: 'invalid_price' });
    }

    const VALID_CATEGORIES = ['mobile', 'pc', 'social', 'boosting', 'currency'];
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'invalid_category' });
    }

    const { rows } = await db.query(`
      INSERT INTO listings
        (seller_id, category, game, listing_type, title, description, tags, price_gel)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [req.user.id, category, game, listing_type, title,
        description || '', tags || [], Number(price_gel)]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('listing create error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/listings/:id  — განახლება
// ══════════════════════════════════════════════════════════════
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: existing } = await db.query(
      'SELECT * FROM listings WHERE id=$1', [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    if (existing[0].seller_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { title, description, tags, price_gel, status } = req.body;
    const { rows } = await db.query(`
      UPDATE listings SET
        title       = COALESCE($1, title),
        description = COALESCE($2, description),
        tags        = COALESCE($3, tags),
        price_gel   = COALESCE($4, price_gel),
        status      = COALESCE($5, status),
        updated_at  = NOW()
      WHERE id=$6
      RETURNING *
    `, [title, description, tags, price_gel, status, req.params.id]);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// DELETE /api/listings/:id
// ══════════════════════════════════════════════════════════════
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT seller_id FROM listings WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].seller_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }

    // soft delete
    await db.query(
      "UPDATE listings SET status='deleted', updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/listings/:id/vip  — VIP-ის გააქტ.
// ══════════════════════════════════════════════════════════════
router.post('/:id/vip', requireAuth, async (req, res) => {
  try {
    const { duration_days = 30, price: clientPrice } = req.body;

    const { rows: listing } = await db.query(
      'SELECT * FROM listings WHERE id=$1', [req.params.id]
    );
    if (!listing.length || listing[0].seller_id !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // ფასის გამოთვლა: 10% განცხ. ფასიდან, მინ. ₾1
    // Frontend-იდან მოდის clientPrice (pre-calculated), backend ამოწმებს
    const computed = Math.max(1, Math.round(Number(listing[0].price_gel) * 0.10 * 100) / 100);
    // clientPrice-ს ვიყენებთ თუ გამოგზავნა, მაგ. frontend-ის მიერ დათვლილი
    // გადამოწმება: უნდა ემთხვეოდეს computed-ს ±₾0.05 (rounding margin)
    const price = clientPrice && Math.abs(Number(clientPrice) - computed) < 0.06
      ? Number(clientPrice)
      : computed;

    // ბალანსის შემოწ.
    const { rows: u } = await db.query(
      'SELECT balance_gel FROM users WHERE id=$1', [req.user.id]
    );
    if (Number(u[0].balance_gel) < price) {
      return res.status(402).json({ error: 'insufficient_balance', needed: price });
    }

    // ატომური ოპ.
    await db.transaction(async (client) => {
      await client.query(
        'UPDATE users SET balance_gel = balance_gel - $1 WHERE id=$2',
        [price, req.user.id]
      );
      const exp = new Date(Date.now() + duration_days * 86400000);
      await client.query(
        'UPDATE listings SET is_vip=TRUE, vip_expires_at=$1 WHERE id=$2',
        [exp, req.params.id]
      );
      await client.query(
        "INSERT INTO transactions(user_id,type,amount_gel,description) VALUES($1,'vip_purchase',$2,$3)",
        [req.user.id, -price, `VIP ${duration_days} დღე (10%)`]
      );
      await client.query(
        'INSERT INTO vip_purchases(listing_id,user_id,duration_days,price_gel,expires_at) VALUES($1,$2,$3,$4,$5)',
        [req.params.id, req.user.id, duration_days, price, exp]
      );
    });

    res.json({ ok: true, vip_until: new Date(Date.now() + duration_days * 86400000), price_paid: price });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
