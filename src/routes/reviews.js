// src/routes/reviews.js
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const push    = require('../utils/push');
const chat    = require('./chat');
const { checkAndSyncVerifiedSeller } = require('../utils/verifiedSeller');
const router  = express.Router();

// ── NO-CACHE — ახალი შეფასება მაშინვე უნდა გამოჩნდეს, დაკეშილი ძველი
// სია არ დაბრუნდეს.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ★ სავარსკვლავო შეფასების ტექსტური რენდერი (system შეტყობინებისთვის)
function starsText(rating) {
  return '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
}

// POST /api/reviews
router.post('/', requireAuth, async (req, res) => {
  try {
    const { order_id, rating, comment } = req.body;
    if (!order_id || !rating)
      return res.status(400).json({ error: 'order_id and rating required' });
    if (rating < 1 || rating > 5)
      return res.status(400).json({ error: 'rating must be 1-5' });

    const { rows: o } = await db.query('SELECT * FROM orders WHERE id=$1', [order_id]);
    if (!o.length) return res.status(404).json({ error: 'order_not_found' });
    const order = o[0];

    if (order.buyer_id !== req.user.id)
      return res.status(403).json({ error: 'only_buyer_can_review' });
    if (order.status !== 'completed')
      return res.status(400).json({ error: 'order_not_completed' });

    const { rows: ex } = await db.query(
      'SELECT id FROM reviews WHERE order_id=$1', [order_id]
    );
    if (ex.length) return res.status(409).json({ error: 'already_reviewed' });

    const { rows } = await db.query(`
      INSERT INTO reviews(order_id,reviewer_id,seller_id,rating,comment)
      VALUES($1,$2,$3,$4,$5) RETURNING *
    `, [order_id, req.user.id, order.seller_id, rating, comment || null]);
    const review = rows[0];

    // ── ვერიფიც. გამყიდველის ავტ. სტატუსის სინქრონიზაცია — ახალმა
    // შეფასებამ შეიძლება საშ. რეიტინგი 4.80-ის ზღვარს იქით/აქეთ გადაიტანოს ──
    await checkAndSyncVerifiedSeller(db, order.seller_id)
      .catch(e => console.error('verified seller sync error:', e.message));

    res.status(201).json(review);

    // ── შეფასება ავტ. ჩნდება გამყიდველის ჩატის ფანჯარაში + push ──
    (async () => {
      try {
        const { rows: listingRows } = await db.query('SELECT title FROM listings WHERE id=$1', [order.listing_id]);
        const listing = listingRows[0] || { title: 'განცხადება' };

        const { rows: roomRows } = await db.query('SELECT id FROM chat_rooms WHERE order_id=$1', [order_id]);
        if (roomRows.length) {
          const roomId = roomRows[0].id;
          const content = `${starsText(rating)}${comment ? `\n„${comment}“` : ''}`;
          const { rows: msgRows } = await db.query(`
            INSERT INTO messages(room_id, sender_id, content, content_type)
            VALUES($1, $2, $3, 'review')
            RETURNING *
          `, [roomId, req.user.id, content]);
          chat.broadcastMessageToRoom(roomId, msgRows[0]);
        }

        await push.sendToUser(order.seller_id, {
          title: `${starsText(rating)} ახალი შეფასება`,
          body: `${listing.title}${comment ? ` — „${comment}“` : ''}`,
          url: `/?page=profile`,
          tag: `review-${review.id}`,
        });
      } catch (e) { console.error('review notify error:', e.message); }
    })();
  } catch (err) {
    console.error('review create:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/reviews  — ადმინის მიმოხილვების მოდერაციის სია
// (ყველა შეფასება, ყველაზე ახალი წინ) — ბოროტად გამოყ./ყალბი
// შეფასების პოვნისა და წაშლისთვის (Watchtower → Reviews).
// ══════════════════════════════════════════════════════════════
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const { rows } = await db.query(`
      SELECT r.*,
        ru.username AS reviewer_username,
        su.username AS seller_username
      FROM reviews r
      JOIN users ru ON ru.id = r.reviewer_id
      JOIN users su ON su.id = r.seller_id
      ORDER BY r.created_at DESC
      LIMIT $1 OFFSET $2
    `, [Number(limit), offset]);

    const { rows: cnt } = await db.query('SELECT COUNT(*) FROM reviews');
    res.json({ reviews: rows, total: Number(cnt[0].count), page: Number(page), pages: Math.ceil(Number(cnt[0].count) / Number(limit)) });
  } catch (err) {
    console.error('admin reviews list error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// DELETE /api/reviews/:id  — ადმინის მიერ ყალბი/შეურაცხმყოფელი
// შეფასების წაშლა. ⚠️ წაშლის შემდეგ სავალდებულოა verified-seller
// სტატუსის ხელახლა სინქრონიზაცია — წაშლილმა დაბალმა/მაღალმა
// შეფასებამ შეიძლება საშ. რეიტინგი 4.80-ის ზღვარს იქით/აქეთ
// გადაიტანოს, ისევე როგორც ახალი შეფასების დამატებისას (ზემოთ POST /).
// ══════════════════════════════════════════════════════════════
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('DELETE FROM reviews WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const deleted = rows[0];

    await checkAndSyncVerifiedSeller(db, deleted.seller_id)
      .catch(e => console.error('verified seller resync (review delete) error:', e.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('admin review delete error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/reviews/seller/:id
router.get('/seller/:id', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT r.*, u.username AS reviewer_username, u.avatar_url AS reviewer_avatar
      FROM reviews r
      JOIN users u ON u.id=r.reviewer_id
      WHERE r.seller_id=$1
      ORDER BY r.created_at DESC
      LIMIT 50
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
