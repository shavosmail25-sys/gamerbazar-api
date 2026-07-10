// src/routes/listings.js
// განცხადებების API

'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth, optionalAuth, requireAdmin } = require('../middleware/auth');
const { requireModerator } = require('../middleware/requireModerator');
const ledger  = require('../utils/ledger');

const router = express.Router();

// ══════════════════════════════════════════════════════════════
// GET /api/listings/moderation/pending  — მოდერაციის რიგი
// (მოდერატორი + admin) — ყველა pending განცხადება, გამყ. ინფოთი
// ══════════════════════════════════════════════════════════════
router.get('/moderation/pending', requireAuth, requireModerator, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT l.*, u.username AS seller_username, u.email AS seller_email,
             u.display_name AS seller_display_name, u.created_at AS seller_joined_at
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      WHERE l.status = 'pending'
      ORDER BY l.created_at ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('moderation pending list error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/listings/suggest  — search autocomplete (game/title)
// ══════════════════════════════════════════════════════════════
router.get('/suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ games: [], titles: [] });

    const [gamesRes, titlesRes] = await Promise.all([
      db.query(`
        SELECT DISTINCT game FROM listings
        WHERE status='active' AND game ILIKE $1
        ORDER BY game LIMIT 5
      `, [`%${q}%`]),
      db.query(`
        SELECT id, title, game, price_gel FROM listings
        WHERE status='active' AND title ILIKE $1
        ORDER BY is_vip DESC, created_at DESC LIMIT 5
      `, [`%${q}%`]),
    ]);

    res.json({
      games: gamesRes.rows.map(r => r.game),
      titles: titlesRes.rows,
    });
  } catch (err) {
    console.error('listings suggest error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

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

    // მთავარ გვერდზე მხოლოდ active, profile-ზე ყველა სტატუსი
    const statusFilter = seller_id
      ? (include_sold === 'true'
          ? "l.status IN ('active','sold','pending','inactive','rejected')"
          : "l.status IN ('active','pending','inactive','rejected')")
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

    // listing_type ვალიდაცია — service → boosting alias
    const VALID_TYPES = ['account', 'boosting', 'currency', 'service'];
    const normalizedType = listing_type === 'service' ? 'boosting' : listing_type;
    if (!VALID_TYPES.includes(listing_type)) {
      return res.status(400).json({ error: 'invalid_listing_type' });
    }

    const { rows } = await db.query(`
      INSERT INTO listings
        (seller_id, category, game, listing_type, title, description, tags, price_gel, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
      RETURNING *
    `, [req.user.id, category, game, normalizedType, title,
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
    const isPrivileged = ['admin', 'moderator'].includes(req.user.role);
    if (existing[0].seller_id !== req.user.id && !isPrivileged) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { title, description, tags, price_gel } = req.body;
    let { status } = req.body;

    // ⚠️ უსაფრთხოების გასწორება: ჩვეულებრივ გამყიდველს (არა admin/moderator)
    // აქამდე შეეძლო ამ endpoint-ით ნებისმიერი status გაეგზავნა — მათ შორის
    // პირდაპირ 'active', რაც მთლიანად აუქმებდა მოდერაციის რიგს. ახლა
    // non-privileged იუზერს status-ის შეცვლა შეუძლია მხოლოდ ერთ
    // კონკრეტულ, უსაფრთხო შემთხვევაში — საკუთარი უარყოფილი (rejected)
    // განცხადების ხელახლა მოდერაციაზე გაგზავნისას (rejected → pending).
    if (status !== undefined && !isPrivileged) {
      const allowedResubmit = status === 'pending' && existing[0].status === 'rejected';
      if (!allowedResubmit) status = undefined;
    }

    const params = [title, description, tags, price_gel, status, req.params.id];
    const { rows } = await db.query(`
      UPDATE listings SET
        title       = COALESCE($1, title),
        description = COALESCE($2, description),
        tags        = COALESCE($3, tags),
        price_gel   = COALESCE($4, price_gel),
        status      = COALESCE($5, status),
        rejection_reason = CASE WHEN $5 = 'pending' THEN NULL ELSE rejection_reason END,
        updated_at  = NOW()
      WHERE id=$6
      RETURNING *
    `, params);

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

    // ფასის გამოთვლა: 5% განცხ. ფასიდან (გლობალური, ერთიანი საკომისიო — ledger.js), მინ. ₾1
    // Frontend-იდან მოდის clientPrice (pre-calculated), backend ამოწმებს
    const { fee: computedFee } = ledger.splitCommission(listing[0].price_gel);
    const computed = Math.max(1, computedFee);
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
        `INSERT INTO transactions(user_id,type,amount_gel,gross_amount_gel,net_amount_gel,commission_fee_gel,description)
         VALUES($1,'vip_purchase',$2,$3,0,$3,$4)`,
        [req.user.id, -price, price, `VIP ${duration_days} დღე (5%)`]
      );
      await client.query(
        'INSERT INTO vip_purchases(listing_id,user_id,duration_days,price_gel,expires_at) VALUES($1,$2,$3,$4,$5)',
        [req.params.id, req.user.id, duration_days, price, exp]
      );
      // VIP საკომისიო — ეს არის პლატფორმის შემოსავალი (არა escrow-ის
      // ნაწილი), ამიტომ პირდაპირ platform_stats.admin_earnings_gel-ს
      // ემატება — იგივე ადგილი, საიდანაც Watch Tower-ში ადმინი (ერთადერთი
      // admin ანგარიში — shavosmail25@gmail.com) ხედავს პლატფორმის
      // მთლიან შემოსავალს. აქამდე ეს თანხა უბრალოდ ქრებოდა (debit-ი
      // ხდებოდა გამყიდველზე, მაგრამ არსად არ ირიცხებოდა შემდეგ).
      await ledger.recordPlatformFee(client, price);
    });

    res.json({ ok: true, vip_until: new Date(Date.now() + duration_days * 86400000), price_paid: price });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/listings/:id/images  — სურათების ატვირთვა (Cloudinary)
// მაქს. 5 სურათი, თითო 3MB, jpeg/png/webp
// Render-ის filesystem ephemeral-ია — დისკზე აღარ ვინახავთ,
// ფაილი მეხსიერებიდან (multer memoryStorage) პირდაპირ Cloudinary-ში იტვირთება
// ══════════════════════════════════════════════════════════════
const multer     = require('multer');
const cloudinary = require('../utils/cloudinary');

const imgUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: (Number(process.env.MAX_FILE_SIZE_MB) || 3) * 1024 * 1024,
    files: 5,
  },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|webp)/.test(file.mimetype);
    cb(ok ? null : new Error('only_images'), ok);
  },
});

router.post('/:id/images', requireAuth, imgUpload.array('images', 5), async (req, res) => {
  try {
    if (!cloudinary.isConfigured())
      return res.status(503).json({ error: 'image_upload_not_configured' });
    if (!req.files || !req.files.length)
      return res.status(400).json({ error: 'no_files' });

    // ownership check — ატვირთვამდე, რომ ფუჭად არ დავხარჯოთ Cloudinary quota
    const { rows } = await db.query(
      'SELECT seller_id, images FROM listings WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });

    // Cloudinary-ში ატვირთვა — თითოეული ფაილი ცალკე, პარალელურად
    const uploaded = await Promise.all(req.files.map((f, i) => {
      const publicId = `listing_${req.params.id}_${Date.now()}_${i}_${Math.random().toString(36).slice(2,7)}`;
      return cloudinary.uploadBuffer(f.buffer, {
        folder: 'gamerbazar/listings',
        public_id: publicId,
        resource_type: 'image',
      });
    }));
    const newUrls = uploaded.map(r => r.secure_url);

    // არსებულ სურ-ებს ვამატებთ (მაქს. 5 სულ)
    const existing = rows[0].images || [];
    const combined = [...existing, ...newUrls].slice(0, 5);

    await db.query(
      'UPDATE listings SET images=$1, updated_at=NOW() WHERE id=$2',
      [combined, req.params.id]
    );

    res.json({ ok: true, images: combined });
  } catch (err) {
    if (err.message === 'only_images')
      return res.status(400).json({ error: 'only_images_allowed' });
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(400).json({ error: 'file_too_large', max_mb: process.env.MAX_FILE_SIZE_MB || 3 });
    console.error('image upload:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/listings/:id/images  — სურათის წაშლა (Cloudinary-დანაც)
router.delete('/:id/images', requireAuth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    const { rows } = await db.query(
      'SELECT seller_id, images FROM listings WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });

    const updated = (rows[0].images || []).filter(u => u !== url);
    await db.query(
      'UPDATE listings SET images=$1, updated_at=NOW() WHERE id=$2',
      [updated, req.params.id]
    );

    // Cloudinary-დანაც წავშალოთ (ძველი /uploads/... ლოკალური ბმულები — silent skip)
    if (url.includes('res.cloudinary.com')) {
      cloudinary.destroyByUrl(url).catch(() => {});
    }

    res.json({ ok: true, images: updated });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/listings/:id/approve  — Moderator/Admin: pending → active + push
// ══════════════════════════════════════════════════════════════
router.post('/:id/approve', requireAuth, requireModerator, async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE listings SET status='active', moderated_by=$2, moderated_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_not_pending' });
    res.json(rows[0]);

    // push + email გამყიდველს
    (async () => {
      try {
        const push = require('../utils/push');
        await push.sendToUser(rows[0].seller_id, {
          title: '✅ განცხადება დადასტ.!',
          body: `"${rows[0].title}" — საიტზე გამოჩნდა`,
          url: '/?page=profile',
          tag: `listing-approved-${rows[0].id}`,
        });
      } catch(e) { console.error('approve notify:', e.message); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/listings/:id/reject  — Moderator/Admin: pending → rejected (+ მიზეზი) + push
router.post('/:id/reject', requireAuth, requireModerator, async (req, res) => {
  try {
    const { reason = '' } = req.body;
    if (!reason.trim()) {
      return res.status(400).json({ error: 'reason_required', message: 'უარყოფის მიზეზი სავალდებულოა' });
    }
    const { rows } = await db.query(
      `UPDATE listings SET status='rejected', rejection_reason=$2, moderated_by=$3, moderated_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id, reason.trim(), req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_not_pending' });
    res.json({ ok: true, listing: rows[0] });

    (async () => {
      try {
        const push = require('../utils/push');
        await push.sendToUser(rows[0].seller_id, {
          title: '❌ განცხადება უარყოფილია',
          body: reason.trim(),
          url: '/?page=profile',
          tag: `listing-rejected-${rows[0].id}`,
        });
      } catch(e) { console.error('reject notify:', e.message); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/listings/:id/delist  — active/pending → inactive
router.post('/:id/delist', requireAuth, async (req, res) => {
  try {
    const { rows: ex } = await db.query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    if (!ex.length) return res.status(404).json({ error: 'not_found' });
    if (ex[0].seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });
    if (!['active','pending'].includes(ex[0].status))
      return res.status(400).json({ error: 'cannot_delist' });

    const { rows } = await db.query(
      "UPDATE listings SET status='inactive', updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/listings/:id/relist  — inactive → pending
router.post('/:id/relist', requireAuth, async (req, res) => {
  try {
    const { rows: ex } = await db.query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    if (!ex.length) return res.status(404).json({ error: 'not_found' });
    if (ex[0].seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });
    if (ex[0].status !== 'inactive')
      return res.status(400).json({ error: 'not_inactive' });

    const { rows } = await db.query(
      "UPDATE listings SET status='pending', updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;

