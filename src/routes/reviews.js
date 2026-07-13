// src/routes/reviews.js
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const push    = require('../utils/push');
const chat    = require('./chat');
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
