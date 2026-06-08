// src/routes/reviews.js
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

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

    res.status(201).json(rows[0]);
  } catch (err) {
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
