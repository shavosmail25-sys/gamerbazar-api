// src/routes/users.js
'use strict';

const express     = require('express');
const multer      = require('multer');
const db          = require('../db');
const cloudinary  = require('../utils/cloudinary');
const ledger      = require('../utils/ledger');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// ── NO-CACHE — პროფილი/ბალანსი/VIP სტატუსი ხშირად იცვლება; ვუკრძალავთ
// ბრაუზერს/პროქსის ამ პასუხების დაკეშვას.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

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

// ── Cover Banner Upload config ──────────────────────────────────
// იგივე memoryStorage → Cloudinary პატერნი, რაც ავატარს აქვს, უბრალოდ
// ცალკე ლიმიტით — ბანერები ჩვეულებრივ ავატარებზე მსხვილი სურათებია
// (განიერი 16:5-სთვის მოსახერხებელი ფაილები), ამიტომ ცალკე,
// უფრო დიდი ზომის ლიმიტი აქვს (default 5MB ვიდრე ავატარის 2MB).
const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_COVER_SIZE_MB) || 5) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|webp|gif)/.test(file.mimetype);
    cb(ok ? null : new Error('only_images'), ok);
  },
});

// ── ონლაინ სტატუსის "ცოცხალი" ფანჯარა — ამ ხნის განმავლობაში ბოლო
// აქტივობის შემდეგ მომხმარებელი ჯერ კიდევ "ონლაინად" ითვლება
// (last_seen_at heartbeat-ს frontend-ი ავტ. ანახლებს გვერდზე ყოფნისას) ──
const ONLINE_WINDOW_MINUTES = 5;

// GET /api/users/:id  — საჯარო პროფილი
//
// ⚠️ REVIEWS BUG FIX: წინა ვერსია საერთოდ არ აბრუნებდა ინდივიდუალურ
// შეფასებებს — მხოლოდ სააგრეგაციო avg_rating/review_count-ს
// (seller_stats view-დან). Reviews ტაბს frontend-ი ცალკე endpoint-ს
// ეძახდა, საიდანაც rating/comment ველები ან საერთოდ არ ბრუნდებოდა,
// ან frontend-ის ვარსკვლავების რენდერში იყო ბაგი — ორივე მიზეზით
// ტაბზე მხოლოდ სახელი+თარიღი ჩანდა. ახლა ეს ერთადერთი, სანდო წყაროა:
// ქვემოთ პარალელურად მოაქვს რეალური მწკრივები (r.rating, r.comment,
// r.created_at) + შემფასებლის პროფილის ინფო ერთი JOIN-ით — frontend
// (loadMyReviews/openSellerProfile/loadSellerReviewsForListing) ახლა
// ყველგან ამ ერთი, სრული პასუხიდან იღებს `reviews`-ს. ──
router.get('/:id', async (req, res) => {
  try {
    const [userRes, listingsRes, reviewsRes] = await Promise.all([
      db.query(`
        SELECT
          u.id, u.username, u.display_name, u.bio, u.avatar_url, u.cover_url,
          u.is_verified_seller, u.created_at,
          -- is_vip დროშას ვამოწმებთ ვადასთან ერთად — cron ყოველ საათში
          -- ასუფთავებს ვადაგასულებს, მაგრამ ეს defense-in-depth ხდის
          -- პასუხს სწორს იმ საათამდეც, სანამ cron არ ჩაირთვება
          (u.is_vip AND u.vip_expires_at IS NOT NULL AND u.vip_expires_at > NOW()) AS is_vip,
          u.vip_expires_at,
          u.total_sales_gel,
          -- ონლაინ სტატუსის ინდიკატორი — მხოლოდ თუ მომხმარებელს ჩართული
          -- აქვს "ონლაინ სტატუსი" (show_online, იხ. edit-გვ. toggle) და
          -- ბოლო აქტივობა ბოლო ONLINE_WINDOW_MINUTES წუთშია. show_online=FALSE
          -- იმალავს ინდიკატორს მთლიანად (ხდება "offline" საჯაროდ) — last_seen_at-ს
          -- საერთოდ არ ვაბრუნებთ საჯაროდ, კონფიდენციალურობისთვის.
          (u.show_online AND u.last_seen_at IS NOT NULL
            AND u.last_seen_at > NOW() - INTERVAL '${ONLINE_WINDOW_MINUTES} minutes') AS is_online,
          COALESCE(ss.avg_rating, 0)        AS avg_rating,
          COALESCE(ss.review_count, 0)      AS review_count,
          COALESCE(ss.completed_orders, 0)  AS completed_orders
        FROM users u
        LEFT JOIN seller_stats ss ON ss.seller_id=u.id
        WHERE u.id=$1 AND u.profile_public=TRUE AND u.role!='banned'
      `, [req.params.id]),

      // განცხადებები
      db.query(`
        SELECT id,title,game,listing_type,price_gel,is_vip,created_at
        FROM listings WHERE seller_id=$1 AND status='active'
        ORDER BY is_vip DESC, created_at DESC LIMIT 12
      `, [req.params.id]),

      // ── შეფასებები — rating/comment/created_at + შემფასებლის
      // (reviewer) საჯარო პროფილის ინფო ერთი JOIN-ით. ბოლო 30 —
      // Reviews ტაბს/სელერ-მოდალს ესმის "ბოლოდან"; მეტი საჭიროებისას
      // მარტივად შეიცვლება pagination-ად. ──
      db.query(`
        SELECT
          r.id, r.rating, r.comment, r.created_at,
          ru.id AS reviewer_id, ru.username AS reviewer_username,
          ru.display_name AS reviewer_display_name, ru.avatar_url AS reviewer_avatar
        FROM reviews r
        JOIN users ru ON ru.id = r.reviewer_id
        WHERE r.seller_id = $1
        ORDER BY r.created_at DESC
        LIMIT 30
      `, [req.params.id]),
    ]);

    if (!userRes.rows.length) return res.status(404).json({ error: 'not_found' });

    res.json({ ...userRes.rows[0], listings: listingsRes.rows, reviews: reviewsRes.rows });
  } catch (err) {
    console.error('user profile error:', err.message);
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
// POST /api/users/me/cover  — პროფილის ქავერ ბანერის ატვირთვა (Cloudinary)
// ══════════════════════════════════════════════════════════════
router.post('/me/cover', requireAuth, coverUpload.single('cover'), async (req, res) => {
  try {
    if (!cloudinary.isConfigured())
      return res.status(503).json({ error: 'image_upload_not_configured' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    // public_id მუდმივად იგივეა ამ მომხ-სთვის — ახალი ატვირთვა overwrite-ავს
    // ძველს Cloudinary-ში, ცალკე disk cleanup აღარ სჭირდება (იგივე პატერნი,
    // რაც ავატარის ატვირთვას აქვს ზემოთ).
    const result = await cloudinary.uploadBuffer(req.file.buffer, {
      folder: 'gamerbazar/covers',
      public_id: `cover_${req.user.id}`,
      overwrite: true,
      invalidate: true,
      resource_type: 'image',
    });

    await db.query('UPDATE users SET cover_url=$1 WHERE id=$2', [result.secure_url, req.user.id]);
    res.json({ cover_url: result.secure_url });
  } catch (err) {
    if (err.message === 'only_images')
      return res.status(400).json({ error: 'only_images_allowed' });
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(400).json({ error: 'file_too_large', max_mb: process.env.MAX_COVER_SIZE_MB || 5 });
    console.error('cover upload:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/users/me/cover  — ქავერ ბანერის მოხსნა (default გრადიენტზე დაბრუნება)
router.delete('/me/cover', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT cover_url FROM users WHERE id=$1', [req.user.id]);
    const oldUrl = rows[0]?.cover_url;

    await db.query('UPDATE users SET cover_url=NULL WHERE id=$1', [req.user.id]);

    if (oldUrl && oldUrl.includes('res.cloudinary.com')) {
      cloudinary.destroyByUrl(oldUrl).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('cover delete:', err.message);
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

    // ── ⚠️ ბალანსის საკმარისობის შემოწმება ("balance_gel < price")
    // აქედან განზრახ ამოღებულია — ეს აქ, ტრანზაქციის გარეთ ცალკე
    // SELECT-ით ხდებოდა და სწორედ ეს იყო race condition-ის წყარო:
    // ორ თითქმის ერთდროულ request-ს შორის ორივეს შეეძლო წაეკითხა
    // ჯერ კიდევ არ-შემცირებული ბალანსი და ორივეს გაევლო ეს შემოწმება,
    // სანამ არცერთს ჯერ არ ჩაეჭრა თანხა. ბალანსის რეალური
    // შემოწმება+ჩამოჭრა ახლა ერთ ატომურ UPDATE-ად არის გაერთიანებული
    // ქვემოთ, ტრანზაქციის შიგნით (იხ. "UPDATE users ... WHERE
    // balance_gel >= $1"). is_vip/vip_expires_at კი აქვე გვჭირდება
    // მხოლოდ stacking-ის დღეების გამოსათვლელად — ეს ფულთან
    // დაკავშირებული არაა, ამიტომ საკმარისია ჩვეულებრივი SELECT.
    const { rows: u } = await db.query(
      'SELECT is_vip, vip_expires_at FROM users WHERE id=$1', [req.user.id]
    );
    if (!u.length) return res.status(404).json({ error: 'user_not_found' });

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
    try {
      await db.transaction(async (client) => {
        // ── Race condition-ის გასწორება: ბალანსის შემოწმება და ჩამოჭრა
        // ერთ ატომურ UPDATE-ში ვაერთიანებთ (WHERE balance_gel >= $1).
        // PostgreSQL ამ UPDATE-ის შესრულებისას ავტომატურად კეტავს
        // მწკრივს — თუ ორი პარალელური request თითქმის ერთდროულად
        // მოვა, მეორე პირველის commit/rollback-მდე დაელოდება და
        // ბალანსს უკვე განახლებულს დაინახავს. თუ ბალანსი არასაკმარისია,
        // 0 row ბრუნდება — ამ შემთხვევაში ტრანზაქციას ვწყვეტთ
        // (throw) ფულის დანარჩენი მოძრაობის (is_vip/listings sync/
        // ledger fee) გარეშე.
        const { rows: charged } = await client.query(
          `UPDATE users SET balance_gel = balance_gel - $1
           WHERE id=$2 AND balance_gel >= $1
           RETURNING balance_gel`,
          [price, req.user.id]
        );
        if (!charged.length) {
          throw new Error('__insufficient_balance__');
        }

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
    } catch (txErr) {
      if (txErr.message === '__insufficient_balance__') {
        return res.status(402).json({ error: 'insufficient_balance', needed: price });
      }
      throw txErr; // სხვა შეცდომები გარე catch-ში 500-ით მუშავდება
    }

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
