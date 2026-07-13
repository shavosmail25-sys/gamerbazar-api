// src/routes/admin.js
// Admin Panel API — dispute resolve, user ban, listings moderation
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const mailer  = require('../utils/mailer');
const push    = require('../utils/push');
const ledger  = require('../utils/ledger');
const referral = require('../utils/referral');
const chat    = require('./chat');
const { checkAndSyncVerifiedSeller } = require('../utils/verifiedSeller');
const router  = express.Router();

// ── სუპერ-ადმინის Email ──────────────────────────────────────────
// უსაფრთხოების აუდიტის მოთხოვნით ჰარდქოდირებული fallback მისამართი
// მთლიანად ამოღებულია. SUPER_ADMIN_EMAIL სავალდებულოდ უნდა მოდიოდეს
// .env-დან — თუ ცვლადი არ არის განსაზღვრული, სერვერი საერთოდ ვერ ჩაეშვება
// (fail-closed), რომ არასდროს მოხდეს რომელიმე default/hardcoded მისამართზე
// super-admin წვდომის შემთხვევითი მინიჭება (მაგ. /users/:id/set-role).
if (!process.env.SUPER_ADMIN_EMAIL) {
  throw new Error(
    '[admin.js] SUPER_ADMIN_EMAIL გარემოს ცვლადი არ არის დაყენებული. ' +
    'დააყენე .env ფაილში სუპერ-ადმინის ემაილი — hardcoded fallback განზრახ ამოღებულია.'
  );
}
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL.toLowerCase().trim();

// ყველა route მოითხოვს admin როლს
router.use(requireAuth, requireAdmin);

// ══════════════════════════════════════════════════════════════
// GET /api/admin/overview  — dashboard სტატისტიკა
// ══════════════════════════════════════════════════════════════
router.get('/overview', async (req, res) => {
  try {
    const [users, listings, orders, disputes, volume, platform] = await Promise.all([
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE role='banned') AS banned FROM users"),
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status='active') AS active FROM listings"),
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status='active') AS active, COUNT(*) FILTER (WHERE status='completed') AS completed FROM orders"),
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status='open') AS open FROM disputes"),
      db.query("SELECT COALESCE(SUM(amount_gel),0) AS total FROM orders WHERE status='completed'"),
      db.query("SELECT admin_earnings_gel FROM platform_stats WHERE id=1"),
    ]);

    res.json({
      users: { total: Number(users.rows[0].n), banned: Number(users.rows[0].banned) },
      listings: { total: Number(listings.rows[0].n), active: Number(listings.rows[0].active) },
      orders: {
        total: Number(orders.rows[0].n),
        active: Number(orders.rows[0].active),
        completed: Number(orders.rows[0].completed),
      },
      disputes: { total: Number(disputes.rows[0].n), open: Number(disputes.rows[0].open) },
      volume_gel: Number(volume.rows[0].total),
      admin_earnings_gel: Number(platform.rows[0]?.admin_earnings_gel || 0),
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
        await client.query(
          "UPDATE orders SET escrow_status='released',status='completed',completed_at=NOW() WHERE id=$1",
          [order.id]
        );
        await client.query(
          "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'sale_income',$3,'დავის გადაწყვ. — გამყ-ზე გადახდა (48სთ hold)')",
          [order.seller_id, order.id, order.seller_receives]
        );
        // ── ვერიფიც. გამყიდველის ავტ. სტატუსის სინქრონიზაცია — დავის
        // "release" გადაწყვ.-იც დასრულებულ გაყიდვად ითვლება ──
        await checkAndSyncVerifiedSeller(client, order.seller_id);
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
// PUT /api/admin/users/:id/set-role  — მოდერატორის სტატუსის მინიჭება/ჩამორთმევა
// ⚠️ მხოლოდ SUPER_ADMIN_EMAIL-ს (იხ. ფაილის თავი) შეუძლია ამის გაკეთება —
// ჩვეულებრივ admin-ებსაც კი არა, სპეციალურად ამ მოთხოვნის მიხედვით.
// ══════════════════════════════════════════════════════════════
router.put('/users/:id/set-role', async (req, res) => {
  try {
    // req.user.email-ის არსებობაზე არ ვიმედოვნებთ (middleware/auth.js ფაილი
    // ხელმისაწვდომი არ იყო ამ ცვლილების დაწერისას) — მოქმედი ადმინის
    // ემაილს პირდაპირ ბაზიდან ვამოწმებთ req.user.id-ით, რაც ყველა
    // route-ში საიმედოდ არის ხელმისაწვდომი.
    const { rows: me } = await db.query('SELECT email FROM users WHERE id=$1', [req.user.id]);
    if (!me.length || (me[0].email || '').toLowerCase().trim() !== SUPER_ADMIN_EMAIL) {
      return res.status(403).json({ error: 'super_admin_only', message: 'მხოლოდ სუპერ-ადმინს შეუძლია როლის მინიჭება' });
    }
    const { role } = req.body;
    if (!['user', 'moderator', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role' });
    }
    const { rows: target } = await db.query('SELECT id, email, role FROM users WHERE id=$1', [req.params.id]);
    if (!target.length) return res.status(404).json({ error: 'not_found' });
    if (target[0].role === 'banned') {
      return res.status(400).json({ error: 'cannot_change_banned_user_role' });
    }

    const { rows } = await db.query(
      'UPDATE users SET role=$1, updated_at=NOW() WHERE id=$2 RETURNING id, email, username, role',
      [role, req.params.id]
    );
    res.json({ ok: true, user: rows[0] });
  } catch (err) {
    console.error('set-role error:', err.message);
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
// DELETE /api/admin/listings/:id  — მოხსნა (მიზეზით) + შეტყობინებები
//
// ⚠️ ცვლილება: ადმინის მიერ განცხადების მოხსნა ახლა მოითხოვს
// სავალდებულო "reason"-ს request body-ში (frontend-ზე მოდალით
// შეყვანილს — იხ. admin.html openRemoveModal). წაშლის შემდეგ
// გამყიდველს ეგზავნება:
//   A) Email — იმავე მიზეზის ტექსტით (mailer.sendListingRemovedEmail)
//   B) ჩატის სისტ. შეტყობინება — იმავე ზუსტი მიზეზით (chat.sendAdminNotice)
//   C) Push შეტყობინება (არსებული პატერნის მიხედვით)
// ══════════════════════════════════════════════════════════════
router.delete('/listings/:id', async (req, res) => {
  try {
    const { reason = '' } = req.body;
    if (!reason.trim()) {
      return res.status(400).json({
        error: 'reason_required',
        message: 'განცხადების მოხსნის მიზეზი სავალდებულოა',
      });
    }

    const { rows } = await db.query(
      `UPDATE listings SET
         status='deleted', rejection_reason=$2,
         moderated_by=$3, moderated_at=NOW(), updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, reason.trim(), req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const listing = rows[0];

    res.json({ ok: true });

    // ── შეტყობ. — Email + ჩატი + push, ყველა იმავე ზუსტი მიზეზით ──
    (async () => {
      try {
        const { rows: sellerRows } = await db.query(
          'SELECT id, email, username, display_name, notif_email FROM users WHERE id=$1',
          [listing.seller_id]
        );
        const seller = sellerRows[0];
        if (!seller) return;

        if (seller.notif_email) {
          await mailer.sendListingRemovedEmail(seller, listing, reason.trim());
        }

        await chat.sendAdminNotice(
          seller.id,
          `🚫 თქვენი განცხადება „${listing.title}“ მოხსნილია საიტიდან ადმინისტრაციის მიერ.\nმიზეზი: ${reason.trim()}`
        );

        await push.sendToUser(seller.id, {
          title: '🚫 განცხადება მოხსნილია',
          body: reason.trim(),
          url: '/?page=profile',
          tag: `listing-removed-${listing.id}`,
        });
      } catch (e) { console.error('admin listing remove notify error:', e.message); }
    })();
  } catch (err) {
    console.error('admin listing remove error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/deposits  — pending deposit მოთხოვნები
// ══════════════════════════════════════════════════════════════
router.get('/deposits', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT t.*, u.username, u.email, u.display_name
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      WHERE t.type = 'deposit' AND t.status = 'pending'
      ORDER BY t.created_at ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/deposits/:id/confirm  — deposit დადასტ.
router.post('/deposits/:id/confirm', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: tx } = await db.query(
      "SELECT * FROM transactions WHERE id=$1 AND type='deposit' AND status='pending'",
      [req.params.id]
    );
    if (!tx.length) return res.status(404).json({ error: 'not_found' });

    // ⚠️ დეპოზიტზე საკომისიო არ არის აღებული (0%) — გადაწყვეტილება:
    // თანხის შემოტანა თავისთავად ღირებულების შექმნა არაა (ინდუსტრიის
    // სტანდარტი — Steam Market/G2G/Eldorado არც ერთი არ იღებს deposit fee-ს).
    // 5%-იანი საკომისია რჩება მხოლოდ იქ, სადაც რეალურად აქტიური ტრანზაქციაა:
    // გაყიდვა (orders.js), გამოტანა (wallet.js), VIP (listings.js).
    const gross = Number(tx[0].amount_gel);

    // ── REFERRAL: "პირველი დეპოზიტი" ჯილდოს ტრიგერი ზუსტად აქ ცხადდება —
    // ეს არის ის ერთადერთი წერტილი, სადაც დეპოზიტის ფული რეალურად შედის
    // მომხმარებლის ბალანსზე (ადმინის მიერ დადასტურებული ბანკის გადარიცხვა).
    // wallet.js-ის POST /deposit მხოლოდ 'pending' მოთხოვნას ქმნის და
    // არასდროს არ უნდა გაააქტიუროს ბონუსი. ──
    let referralResult = { granted: false };

    await db.transaction(async (client) => {
      await client.query(
        `UPDATE transactions SET
           status='completed',
           net_amount_gel=$2, commission_fee_gel=0, gross_amount_gel=$3
         WHERE id=$1`,
        [req.params.id, gross, gross]
      );
      await client.query(
        'UPDATE users SET balance_gel=balance_gel+$1 WHERE id=$2',
        [gross, tx[0].user_id]
      );

      referralResult = await referral.triggerReferralReward(client, tx[0].user_id, 'deposit');
    });

    // push notification მომხმარებელს
    const push = require('../utils/push');
    await push.sendToUser(tx[0].user_id, {
      title: '✅ ბალანსი შეივსო',
      body: `₾${gross.toFixed(2)} დაემატა შენს ბალანსზე`,
      url: '/?page=wallet',
      tag: `deposit-${req.params.id}`,
    });

    // რეფერერს — ბონუსის შეტყობინება (თუ ჯილდო რეალურად გაიცა)
    if (referralResult.granted) {
      push.sendToUser(referralResult.referrerId, {
        title: '🎉 რეფერალური ბონუსი',
        body: `მოწვეულმა მეგობარმა პირველი დეპოზიტი შეავსო — ₾${referral.REWARD_AMOUNT_GEL.toFixed(2)} დაგერიცხა`,
        url: '/?page=profile',
        tag: `referral-deposit-${tx[0].user_id}`,
      }).catch(e => console.error('referral push (deposit) error:', e.message));
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/deposits/:id/reject  — deposit უარყოფა
router.post('/deposits/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason = '' } = req.body;
    const { rows: tx } = await db.query(
      "SELECT * FROM transactions WHERE id=$1 AND type='deposit' AND status='pending'",
      [req.params.id]
    );
    if (!tx.length) return res.status(404).json({ error: 'not_found' });

    await db.query(
      "UPDATE transactions SET status='failed', description=description||$1 WHERE id=$2",
      [reason ? ` — უარყოფა: ${reason}` : ' — უარყოფილია', req.params.id]
    );

    const push = require('../utils/push');
    await push.sendToUser(tx[0].user_id, {
      title: '❌ შეტანა უარყოფილია',
      body: reason || 'გადარიცხვა ვერ დადასტ. — დაგვიკავშირდი',
      url: '/?page=wallet',
      tag: `deposit-reject-${req.params.id}`,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/withdrawals  — pending გამოტანები
// ══════════════════════════════════════════════════════════════
router.get('/withdrawals', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT t.*, u.username, u.email, u.display_name
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      WHERE t.type = 'withdrawal' AND t.status = 'pending'
      ORDER BY t.created_at ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/withdrawals/:id/confirm  — გამოტანა დადასტ.
router.post('/withdrawals/:id/confirm', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: tx } = await db.query(
      "SELECT * FROM transactions WHERE id=$1 AND type='withdrawal' AND status='pending'",
      [req.params.id]
    );
    if (!tx.length) return res.status(404).json({ error: 'not_found' });

    // საკომისიო უკვე გამოთვლილია მოთხოვნის დროს (wallet.js) და შენახულია
    // commission_fee_gel-ში — აქ მხოლოდ ვაქტ. ვხდით პლატფორმის შემოსავალში,
    // რომ უარყოფის შემთხვევაში (reject) არასდროს დარჩეს "ბრჭყალებში" საკომისიო.
    const fee = Number(tx[0].commission_fee_gel) || 0;
    const net = tx[0].net_amount_gel != null
      ? Number(tx[0].net_amount_gel)
      : Math.abs(Number(tx[0].amount_gel));

    await db.transaction(async (client) => {
      await client.query(
        "UPDATE transactions SET status='completed' WHERE id=$1", [req.params.id]
      );
      if (fee > 0) await ledger.recordPlatformFee(client, fee);
    });

    const push = require('../utils/push');
    await push.sendToUser(tx[0].user_id, {
      title: '✅ გამოტანა დადასტ.',
      body: `₾${net.toFixed(2)} გაიგზავნა შენს ანგარიშზე`,
      url: '/?page=wallet',
      tag: `withdrawal-${req.params.id}`,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/withdrawals/:id/reject  — გამოტანა უარყოფა + თანხა დაბრ.
router.post('/withdrawals/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason = '' } = req.body;
    const { rows: tx } = await db.query(
      "SELECT * FROM transactions WHERE id=$1 AND type='withdrawal' AND status='pending'",
      [req.params.id]
    );
    if (!tx.length) return res.status(404).json({ error: 'not_found' });

    const refundAmount = Math.abs(Number(tx[0].amount_gel));

    await db.transaction(async (client) => {
      await client.query(
        "UPDATE transactions SET status='failed' WHERE id=$1", [req.params.id]
      );
      // თანხა დაბრუნება
      await client.query(
        'UPDATE users SET balance_gel=balance_gel+$1 WHERE id=$2',
        [refundAmount, tx[0].user_id]
      );
      await client.query(
        `INSERT INTO transactions(user_id,type,amount_gel,status,description)
         VALUES($1,'refund',$2,'completed','გამოტანის უარყოფა — თანხა დაბრ.')`,
        [tx[0].user_id, refundAmount]
      );
    });

    const push = require('../utils/push');
    await push.sendToUser(tx[0].user_id, {
      title: '↩️ გამოტანა უარყოფილია',
      body: `₾${refundAmount.toFixed(2)} დაბრუნდა ბალანსზე. ${reason || ''}`,
      url: '/?page=wallet',
      tag: `withdrawal-reject-${req.params.id}`,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
