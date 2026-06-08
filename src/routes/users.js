// src/routes/users.js
'use strict';

const express = require('express');
const path    = require('path');
const multer  = require('multer');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// ── Avatar Upload config ──────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = process.env.UPLOAD_DIR || './uploads';
    require('fs').mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `avatar_${req.user.id}_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: (Number(process.env.MAX_FILE_SIZE_MB) || 2) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|webp|gif)/.test(file.mimetype);
    cb(ok ? null : new Error('only_images'), ok);
  },
});

// GET /api/users/:id  — საჯარო პროფილი
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id, u.username, u.display_name, u.bio, u.avatar_url,
        u.is_verified_seller, u.created_at,
        COALESCE(ss.avg_rating, 0)        AS avg_rating,
        COALESCE(ss.review_count, 0)      AS review_count,
        COALESCE(ss.completed_orders, 0)  AS completed_orders
      FROM users u
      LEFT JOIN seller_stats ss ON ss.seller_id=u.id
      WHERE u.id=$1 AND u.profile_public=TRUE AND u.role!='banned'
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    // განცხადებები
    const { rows: listings } = await db.query(`
      SELECT id,title,game,listing_type,price_gel,is_vip,created_at
      FROM listings WHERE seller_id=$1 AND status='active'
      ORDER BY is_vip DESC, created_at DESC LIMIT 12
    `, [req.params.id]);

    res.json({ ...rows[0], listings });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/users/me/avatar  — ავატარის ატვირთვა
router.post('/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    const url = `/uploads/${req.file.filename}`;
    await db.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [url, req.user.id]);
    res.json({ avatar_url: url });
  } catch (err) {
    if (err.message === 'only_images')
      return res.status(400).json({ error: 'only_images_allowed' });
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
