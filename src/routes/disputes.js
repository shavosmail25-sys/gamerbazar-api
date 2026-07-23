// src/routes/disputes.js
'use strict';

const express    = require('express');
const multer     = require('multer');
const db         = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireModerator } = require('../middleware/requireModerator');
const mailer     = require('../utils/mailer');
const push       = require('../utils/push');
const cloudinary = require('../utils/cloudinary');
const ledger     = require('../utils/ledger');
const chat       = require('./chat');
const { checkAndSyncVerifiedSeller } = require('../utils/verifiedSeller');
const router     = express.Router();

// multer — memoryStorage, Cloudinary-ში ასატვირთად
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: (Number(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024, // 10MB
    files: 5, // მაქს. 5 ფაილი ერთ დავაში
  },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime)/.test(file.mimetype);
    cb(ok ? null : new Error('only_images_or_videos'), ok);
  },
});

// ══════════════════════════════════════════════════════════════
// POST /api/disputes  — დავის გახსნა (± evidence ფაილები)
// multipart/form-data: reason, description, order_id + files[]
// ══════════════════════════════════════════════════════════════
router.post('/', requireAuth, upload.array('evidence', 5), async (req, res) => {
  try {
    const { order_id, reason, description } = req.body;
    if (!order_id || !reason || !description)
      return res.status(400).json({ error: 'required_fields' });

    const { rows: o } = await db.query('SELECT * FROM orders WHERE id=$1', [order_id]);
    if (!o.length) return res.status(404).json({ error: 'order_not_found' });
    const order = o[0];

    if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)
      return res.status(403).json({ error: 'forbidden' });
    if (!['active', 'delivered'].includes(order.status))
      return res.status(400).json({ error: 'cannot_dispute_this_order', current: order.status });

    const { rows: ex } = await db.query('SELECT id FROM disputes WHERE order_id=$1', [order_id]);
    if (ex.length) return res.status(409).json({ error: 'dispute_exists' });

    // ── Evidence ფაილების ატვირთვა Cloudinary-ში ───────────
    const evidenceUrls = [];
    if (req.files && req.files.length > 0) {
      if (!cloudinary.isConfigured()) {
        return res.status(503).json({ error: 'file_upload_not_configured' });
      }
      for (const file of req.files) {
        const isVideo   = file.mimetype.startsWith('video/');
        const result    = await cloudinary.uploadBuffer(file.buffer, {
          folder:        'gamerbazar/disputes',
          resource_type: isVideo ? 'video' : 'image',
          public_id:     `dispute_${order_id}_${Date.now()}_${evidenceUrls.length}`,
        });
        evidenceUrls.push(result.secure_url);
      }
    }

    // ── DB: dispute შექმნა + order → disputed ──────────────
    const { rows } = await db.query(`
      INSERT INTO disputes(order_id, opened_by, reason, description, evidence_urls)
      VALUES($1, $2, $3, $4, $5) RETURNING *
    `, [order_id, req.user.id, reason, description, evidenceUrls]);

    await db.query(`
      UPDATE orders SET
        status        = 'disputed',
        escrow_status = 'disputed',
        disputed_at   = NOW(),
        updated_at    = NOW()
      WHERE id=$1
    `, [order_id]);

    res.status(201).json(rows[0]);

    // ── შეტყობ. ─────────────────────────────────────────────
    (async () => {
      try {
        const dispute      = rows[0];
        const otherPartyId = order.buyer_id === req.user.id ? order.seller_id : order.buyer_id;
        const { rows: listingRows } = await db.query('SELECT title FROM listings WHERE id=$1', [order.listing_id]);
        const listing = listingRows[0] || { title: 'განცხადება' };

        const { rows: recipients } = await db.query(
          `SELECT id, email, notif_email FROM users WHERE id=$1
           UNION
           SELECT id, email, notif_email FROM users WHERE role='admin'`,
          [otherPartyId]
        );

        // ჩატში სისტ. შეტყობინება — ტაიმერი გაიყინა
        const { rows: roomRows } = await db.query('SELECT id FROM chat_rooms WHERE order_id=$1', [order_id]);
        if (roomRows.length) {
          const { rows: msgRows } = await db.query(`
            INSERT INTO messages(room_id, sender_id, content, content_type)
            VALUES($1, $2, '⚠️ დავა გაიხსნა — 48-საათიანი ტაიმერი გაჩერებულია. ადმინისტრაცია განიხილავს საქმეს.', 'system')
            RETURNING *
          `, [roomRows[0].id, req.user.id]);
          chat.broadcastMessageToRoom(roomRows[0].id, msgRows[0]);
          chat.broadcastEventToRoom(roomRows[0].id, {
            event: 'disputed', status: 'disputed', order_status: 'disputed', order_id,
          });
        }

        for (const recipient of recipients) {
          await mailer.sendDisputeOpenedEmail(recipient, dispute, order, listing);
          await push.sendToUser(recipient.id, {
            title: '⚠️ დავა გაიხსნა',
            body: `${listing.title} — ${reason}`,
            url: `/?dispute=${dispute.id}`,
            tag: `dispute-${dispute.id}`,
          });
        }
      } catch (e) { console.error('dispute open notify error:', e.message); }
    })();
  } catch (err) {
    if (err.message === 'only_images_or_videos')
      return res.status(400).json({ error: 'only_images_or_videos_allowed' });
    console.error('dispute create:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/disputes  — დავების სია (მოდერატორი/admin) — ფილტრი სტატუსზე
// ══════════════════════════════════════════════════════════════
router.get('/', requireAuth, requireModerator, async (req, res) => {
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
        o.amount_gel, o.status AS order_status, o.escrow_status, o.listing_id,
        -- ── ANTI-SCAM ევიდენცია — Watchtower-ის დავის ბარათზე პირდაპირ
        -- ჩანს, დაეთანხმა თუ არა მყიდველი Video Proof პირობას, და
        -- ზუსტად როდის გადასცა/ნახა ანგარიშის მონაცემები — ეს ადმინს
        -- საშუალებას აძლევს შეადაროს გარე მტკიცებულებას (პაროლის
        -- ცვლილების დრო) ცალკე გამოძიების გარეშე.
        o.video_proof_agreed, o.credentials_submitted_at, o.credentials_viewed_at,
        o.credentials_reveal_ack_at, o.access_confirm_deadline,
        (o.credentials_secret IS NOT NULL) AS has_credentials,
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
    console.error('disputes list error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/disputes/:id
// ══════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT d.*,
        o.buyer_id, o.seller_id, o.amount_gel, o.listing_id,
        o.video_proof_agreed, o.credentials_submitted_at, o.credentials_viewed_at,
        o.credentials_reveal_ack_at, o.access_confirm_deadline,
        (o.credentials_secret IS NOT NULL) AS has_credentials,
        ob.username AS buyer_username,
        os.username AS seller_username,
        l.title AS listing_title, l.game
      FROM disputes d
      JOIN orders o ON o.id=d.order_id
      JOIN users ob ON ob.id=o.buyer_id
      JOIN users os ON os.id=o.seller_id
      JOIN listings l ON l.id=o.listing_id
      WHERE d.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const d = rows[0];
    const isModerator = ['admin', 'moderator'].includes(req.user.role);
    if (d.buyer_id !== req.user.id && d.seller_id !== req.user.id && !isModerator)
      return res.status(403).json({ error: 'forbidden' });

    // მოდერატორისთვის/ადმინისთვის — მყიდველი-გამყიდველის სრული ჩატის
    // ისტორია, დავის განხილვისთვის საჭირო კონტექსტი
    if (isModerator) {
      const { rows: roomRows } = await db.query(
        'SELECT id FROM chat_rooms WHERE order_id=$1', [d.order_id]
      );
      if (roomRows.length) {
        const { rows: messages } = await db.query(`
          SELECT m.*, u.username AS sender_username
          FROM messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.room_id = $1
          ORDER BY m.created_at ASC
        `, [roomRows[0].id]);
        d.chat_messages = messages;
      } else {
        d.chat_messages = [];
      }
    }

    res.json(d);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/disputes/:id/resolve  — Admin-ის გადაწყვეტილება
//
// ⚠️ უსაფრთხოების გასწორება: ეს როუტი რეალურ ფულად ოპერაციას
// ასრულებს — escrow-ის გათავისუფლებას ან თანხის დაბრუნებას.
// ადრე საკმარისი იყო მოდერატორის უფლება (requireModerator), რაც
// ნიშნავდა, რომ ჩვეულებრივ მოდერატორსაც შეეძლო ფინანსური
// გადაწყვეტილების მიღება. ახლა აქ მკაცრად მოითხოვება requireAdmin —
// მხოლოდ admin-ს შეუძლია დავის დახურვა და თანხის მოძრაობა.
// ══════════════════════════════════════════════════════════════
router.put('/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
  // dispute/order ცვლადები ტრანზაქციის outer scope-ში გამოგვაქვს, რადგან
  // resolve-ის შემდეგ email/push შეტყობინებების ბლოკს (ქვემოთ, async IIFE)
  // იგივე მონაცემები სჭირდება — ეს ახლა ტრანზაქციაში FOR UPDATE-ით
  // locked-ად წაკითხული მდგომარეობაა, აღარ არის ცალკე pre-transaction
  // SELECT (რომელიც race/replay ხარვეზის წყარო იყო).
  let dispute = null;
  let order   = null;
  let alreadyResolved = false;

  try {
    const { resolution, admin_note } = req.body;
    if (!['release','refund'].includes(resolution))
      return res.status(400).json({ error: 'resolution must be release or refund' });

    await db.transaction(async (client) => {
      // ── Race/replay დაცვა 1/2: dispute row-ს ვკეტავთ FOR UPDATE-ით
      // ტრანზაქციის დასაწყისშივე. თუ ორი request (admin-ის ორმაგი
      // დაჭერა, browser-ის retry, ორი admin-ის თანადროული resolve,
      // ან ხელით replay) იმავე dispute id-ზე თითქმის ერთდროულად მოვა,
      // მეორე ამ lock-ს დაელოდება პირველის commit/rollback-მდე და
      // აღარ წაიკითხავს stale (ჯერ კიდევ "open") სტატუსს.
      const { rows: d } = await client.query(
        'SELECT * FROM disputes WHERE id=$1 FOR UPDATE', [req.params.id]
      );
      if (!d.length) return; // dispute დარჩება null → outer scope-ში 404
      dispute = d[0];

      // ── Race/replay დაცვა 2/2: იგივე ლოკი order row-ზეც — escrow_status
      // ცვლილება ხომ order-ს ეხება, არა მხოლოდ dispute-ს.
      const { rows: o } = await client.query(
        'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [dispute.order_id]
      );
      order = o[0];

      // ── Idempotency შემოწმება: თუ დავა უკვე აღარ არის 'open', ან
      // შესაბამისი order-ი უკვე აღარაა escrow_status='held' — ეს
      // ნიშნავს, რომ დავა უკვე გადაწყვეტილია (ამ request-ის წინა
      // გაშვებით, ან პარალელური request-ით, რომელმაც ლოკი უფრო ადრე
      // დაიპყრო). ფულის მოძრაობას აღარ ვიმეორებთ — ვაბრუნებთ 409-ს.
      if (dispute.status !== 'open' || order.escrow_status !== 'held') {
        alreadyResolved = true;
        return;
      }

      if (resolution === 'release') {
        // გამყიდველს + 48სთ hold (იგივე წესი, რაც ჩვეულ confirm-ზე)
        const fee = Number(order.amount_gel) - Number(order.seller_receives);
        await ledger.creditSellerWithHold(client, {
          sellerId:  order.seller_id,
          orderId:   order.id,
          amountGel: order.seller_receives,
          source:    'dispute_release',
        });
        await ledger.recordPlatformFee(client, fee);
        await client.query(
          'UPDATE users SET escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
          [order.amount_gel, order.buyer_id]
        );
        // ── "სანდო გამყიდველის" ბეჯი — დავის 'release' გადაწყვ.-იც
        // ითვლება დასრულ. გაყიდვად, იგივე ლოგიკა რაც orders.js /confirm-ში ──
        await client.query(
          'UPDATE users SET total_sales_gel = total_sales_gel + $1 WHERE id=$2',
          [order.amount_gel, order.seller_id]
        );
        await client.query(
          "UPDATE orders SET escrow_status='released',status='completed',completed_at=NOW(),updated_at=NOW() WHERE id=$1",
          [order.id]
        );
        // ── ვერიფიც. გამყიდველის ავტ. სტატუსის სინქრონიზაცია — დავის
        // "release" გადაწყვ.-იც დასრულებულ გაყიდვად ითვლება ──
        await checkAndSyncVerifiedSeller(client, order.seller_id);
      } else {
        // მყიდველს დაბრ. — deposit-ი hold-ის გარეშე (მყიდველი არ სჯდება hold-ზე)
        await client.query(
          'UPDATE users SET balance_gel=balance_gel+$1, escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
          [order.amount_gel, order.buyer_id]
        );
        await client.query(
          "UPDATE orders SET escrow_status='refunded',status='cancelled',cancelled_at=NOW(),updated_at=NOW() WHERE id=$1",
          [order.id]
        );
      }
      await client.query(`
        UPDATE disputes SET
          status='resolved', resolution=$1, admin_note=$2,
          resolved_by=$3, resolved_at=NOW(), updated_at=NOW()
        WHERE id=$4
      `, [resolution, admin_note || '', req.user.id, req.params.id]);
    });

    if (!dispute) return res.status(404).json({ error: 'not_found' });
    if (alreadyResolved) return res.status(409).json({ error: 'already_resolved' });

    res.json({ ok: true, resolution });

    // შეტყობ. — მყიდველი + გამყიდველი
    (async () => {
      try {
        const { rows: listingRows } = await db.query('SELECT title FROM listings WHERE id=$1', [order.listing_id]);
        const listing = listingRows[0] || { title: 'განცხადება' };
        const disputeForEmail = { ...dispute, resolution, admin_note: admin_note || '' };

        const { rows: parties } = await db.query(
          'SELECT id, email, notif_email FROM users WHERE id=$1 OR id=$2',
          [order.buyer_id, order.seller_id]
        );

        for (const recipient of parties) {
          await mailer.sendDisputeResolvedEmail(recipient, disputeForEmail, order, listing, resolution);
          await push.sendToUser(recipient.id, {
            title: '🛡️ დავა გადაწყდა',
            body: `${listing.title} — ${resolution === 'release' ? 'თანხა გამყ-ს' : 'თანხა მყიდ-ს'}`,
            url: `/?order=${order.id}`,
            tag: `dispute-${dispute.id}-resolved`,
          });
        }

        // ჩატში სისტ. შეტყობინება + რეალურ დროში სტატუსის განახლება,
        // რომ ორივე მხარის ღია ჩატი მყისიერად აჩვენოს საბოლოო შედეგი
        const { rows: roomRows } = await db.query('SELECT id FROM chat_rooms WHERE order_id=$1', [order.id]);
        if (roomRows.length) {
          const outcomeText = resolution === 'release'
            ? 'თანხა გადაირიცხა გამყიდველზე'
            : 'თანხა დაუბრუნდა მყიდველს';
          const { rows: msgRows } = await db.query(`
            INSERT INTO messages(room_id, sender_id, content, content_type)
            VALUES($1, $2, $3, 'system')
            RETURNING *
          `, [roomRows[0].id, req.user.id, `🛡️ დავა გადაწყდა — ${outcomeText}.`]);
          chat.broadcastMessageToRoom(roomRows[0].id, msgRows[0]);
          chat.broadcastEventToRoom(roomRows[0].id, {
            event: 'dispute_resolved',
            order_status: resolution === 'release' ? 'completed' : 'cancelled',
            order_id: order.id,
          });
        }
      } catch (e) { console.error('dispute resolve notify error:', e.message); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
