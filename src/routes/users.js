// src/routes/users.js
'use strict';

const express     = require('express');
const multer      = require('multer');
const db          = require('../db');
const cloudinary  = require('../utils/cloudinary');
const ledger      = require('../utils/ledger');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// ── VIP პაკეტების მკაცრი Whitelist — ფასები ბექენდზეა ფიქსირებული,
// client-ის მიერ გამოგზავნილი ფასი არასდროს გამოიყენება (მხოლოდ
// duration_days მოდის request-ში). იგივე პაკეტები 1:1 უნდა ემთხვეოდეს
// frontend-ის VIP_PACKAGES მუდმივას (gamer-market-ge.html).
// ⚠️ ქვემოთ მითითებული ₾ ღირებულებები მაგალითია — production-ში
// გაშვებამდე შეცვალეთ თქვენი რეალური ბიზნეს ფასებით.
const VIP_PACKAGES = {
  7:  5,
  30: 15,
  90: 35,
};

// ── Avatar Upload config ──────────────────────────────────────
// Render-ის filesystem ephemeral-ია — დისკზე აღარ ვინახავთ,
// ფაილი მეხსიერებიდან (multer memoryStorage) პირდაპირ Cloudinary-ში იტვირთება
const upload = multer({
  storage: multer.memoryStorage(),
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
        -- is_vip დროშას ვამოწმებთ ვადასთან ერთად — cron ყოველ საათში
        -- ასუფთავებს ვადაგასულებს, მაგრამ ეს defense-in-depth ხდის
        -- პასუხს სწორს იმ საათამდეც, სანამ cron არ ჩაირთვება
        (u.is_vip AND u.vip_expires_at IS NOT NULL AND u.vip_expires_at > NOW()) AS is_vip,
        u.vip_expires_at,
        u.total_sales_gel,
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

// POST /api/users/me/avatar  — ავატარის ატვირთვა (Cloudinary)
router.post('/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    if (!cloudinary.isConfigured())
      return res.status(503).json({ error: 'image_upload_not_configured' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    // public_id მუდმივად იგივეა ამ მომხ-სთვის — ახალი ატვირთვა
    // overwrite-ავს ძველს Cloudinary-ში, ცალკე disk cleanup აღარ სჭირდება
    const result = await cloudinary.uploadBuffer(req.file.buffer, {
      folder: 'gamerbazar/avatars',
      public_id: `avatar_${req.user.id}`,
      overwrite: true,
      invalidate: true,
      resource_type: 'image',
    });

    await db.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [result.secure_url, req.user.id]);
    res.json({ avatar_url: result.secure_url });
  } catch (err) {
    if (err.message === 'only_images')
      return res.status(400).json({ error: 'only_images_allowed' });
    console.error('avatar upload:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/users/me/vip  — VIP სტატუსის შესყიდვა (Account-level)
//
// ⚠️ VIP მოდელის რადიკალური ცვლილება: VIP აღარ არის კონკრეტული
// განცხადების თვისება — ეს არის მომხმარებლის ანგარიშის სტატუსი.
// listing_id აღარ სჭირდება საერთოდ, აღარც "აირჩიე განცხადება" picker.
// ყიდვის შემდეგ:
//   1) users.is_vip / vip_expires_at ახლდება (stacking-ით — უკვე
//      აქტიური VIP-ის შემთხვევაში ახალი დღეები ემატება, არ ცვლის)
//   2) ამ გამყიდველის ყველა აქტიური/მოლოდინში მყოფი განცხადება ავტ.
//      სინქრონდება იმავე VIP ვადაზე — ბეჯი ეკუთვნის ანგარიშს, ამიტომ
//      უკვე არსებული განცხადებებიც მაშინვე "VIP" ხდება, ცალკე
//      per-listing მოთხოვნის გარეშე. ახალი განცხადებები კი ისედაც
//      ავტ. იბადებიან VIP დროშით — იხ. POST /api/listings.
//   3) ბალანსიდან იჭრება ბექენდზე ფიქსირებული ფასი (whitelist),
//      რომელიც პლატფორმის საკომისიოში ჩაითვლება.
// ══════════════════════════════════════════════════════════════
router.post('/me/vip', requireAuth, async (req, res) => {
  try {
    const duration_days = Number(req.body.duration_days);

    // მკაცრი whitelist შემოწმება — მხოლოდ ზემოთ განსაზღვრული პაკეტები
    if (!Object.prototype.hasOwnProperty.call(VIP_PACKAGES, duration_days)) {
      return res.status(400).json({
        error: 'invalid_vip_package',
        allowed_days: Object.keys(VIP_PACKAGES).map(Number),
      });
    }
    const price = VIP_PACKAGES[duration_days];

    const { rows: u } = await db.query(
      'SELECT balance_gel, is_vip, vip_expires_at FROM users WHERE id=$1', [req.user.id]
    );
    if (!u.length) return res.status(404).json({ error: 'user_not_found' });
    if (Number(u[0].balance_gel) < price) {
      return res.status(402).json({ error: 'insufficient_balance', needed: price });
    }

    const now        = new Date();
    const durationMs = duration_days * 86400000;

    // Stacking ლოგიკა — თუ ანგარიშს ჯერ კიდევ აქტიური VIP ვადა აქვს,
    // ახალი დღეები არსებულს ემატება; თუ ვადა გავიდა ან პირველი
    // შესყ.-ია — დღევანდელი დღიდან ითვლება.
    const baseTime = (u[0].is_vip && u[0].vip_expires_at && new Date(u[0].vip_expires_at) > now)
      ? new Date(u[0].vip_expires_at).getTime()
      : now.getTime();
    const newExpiry = new Date(baseTime + durationMs);

    // ატომური ოპ.
    await db.transaction(async (client) => {
      await client.query(
        'UPDATE users SET balance_gel = balance_gel - $1 WHERE id=$2',
        [price, req.user.id]
      );
      await client.query(
        'UPDATE users SET is_vip=TRUE, vip_expires_at=$1 WHERE id=$2',
        [newExpiry, req.user.id]
      );

      // ── სინქრონიზაცია listings-თან: ბეჯი ეკუთვნის ანგარიშს, არა
      // ერთ კონკრეტულ ლისტინგს — ამ გამყიდველის ყველა აქტიური/
      // მოლოდინის განცხადება იმავე VIP ვადაზე გადადის ერთბაშად.
      await client.query(
        `UPDATE listings SET is_vip=TRUE, vip_expires_at=$1
         WHERE seller_id=$2 AND status IN ('active','pending')`,
        [newExpiry, req.user.id]
      );

      await client.query(
        `INSERT INTO transactions(user_id,type,amount_gel,gross_amount_gel,net_amount_gel,commission_fee_gel,description)
         VALUES($1,'vip_purchase',$2,$3,0,$3,$4)`,
        [req.user.id, -price, price, `VIP ${duration_days} დღიანი პაკეტი`]
      );
      // listing_id აღარ არსებობს ამ ყიდვაზე — vip_purchases.listing_id
      // ახლა NULL-ადი სვეტია (იხ. setup.js მიგრაცია).
      await client.query(
        'INSERT INTO vip_purchases(user_id,duration_days,price_gel,expires_at) VALUES($1,$2,$3,$4)',
        [req.user.id, duration_days, price, newExpiry]
      );

      // VIP საკომისიო — პლატფორმის შემოსავალი, platform_stats.admin_earnings_gel-ს ემატება.
      await ledger.recordPlatformFee(client, price);
    });

    res.json({
      ok: true,
      vip_until:  newExpiry,
      price_paid: price,
    });
  } catch (err) {
    console.error('vip purchase error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
