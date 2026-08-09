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
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status='active') AS active, COUNT(*) FILTER (WHERE status='pending') AS pending FROM listings"),
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status='active') AS active, COUNT(*) FILTER (WHERE status='completed') AS completed FROM orders"),
      db.query("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status='open') AS open FROM disputes"),
      db.query("SELECT COALESCE(SUM(amount_gel),0) AS total FROM orders WHERE status='completed'"),
      db.query("SELECT admin_earnings_gel FROM platform_stats WHERE id=1"),
    ]);

    res.json({
      users: { total: Number(users.rows[0].n), banned: Number(users.rows[0].banned) },
      listings: { total: Number(listings.rows[0].n), active: Number(listings.rows[0].active), pending: Number(listings.rows[0].pending) },
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
        -- ── ⚠️ ფასის ბაგის გასწორება: Watchtower-ის დავების სიაში
        -- საჩვენებელი "თანხა" აქამდე o.amount_gel-იდან მოდიოდა, რაც
        -- ისტორიულ/გადათვლილ მნიშვნელობებზე არასწორ ჯამებს იძლეოდა
        -- (მაგ. ₾18.88 ნაცვლად ₾10.00-ის ნაცვლად). ახლა პირდაპირ
        -- listings.price_gel-იდან ვიღებთ ზუსტ, უცვლელ ორიგინალურ ფასს.
        l.price_gel AS listing_price_gel,
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
// ⚠️ REMOVED — PUT /api/admin/disputes/:id/resolve
//
// ეს იყო ძველი, დუბლირებული დავის-გადაწყვეტის route, FOR UPDATE
// ლოქის გარეშე (SELECT და შემდგომი UPDATE ცალკე ხდებოდა) — ორმაგი
// გამოძახება (double-click/network retry) ორმაგად დაერიცხებოდა ან
// დაუბრუნებდა escrow-ს. სრულად ჩანაცვლებულია disputes.js-ის
// PUT /api/disputes/:id/resolve-ით, რომელიც dispute/order row-ებს
// ტრანზაქციაში FOR UPDATE-ით კეტავს და ატომურად ამოწმებს
// idempotency-ს. admin.html უკვე მხოლოდ იმ route-ს იძახებს.
// ══════════════════════════════════════════════════════════════

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
// GET /api/admin/users/:id  — მომხმარებლის სრული პროფილი + ტრანზაქციების
// ისტორია (ბოლო 100). ⚠️ განსხვავებით users.js-ის საჯარო GET /:id-სგან,
// აქ profile_public/role='banned' შეზღუდვები არ მოქმედებს — ადმინს
// ნებისმიერი ანგარიშის ნახვა უნდა შეეძლოს, დაბლოკილის ჩათვლით.
// ══════════════════════════════════════════════════════════════
router.get('/users/:id', async (req, res) => {
  try {
    const { rows: u } = await db.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!u.length) return res.status(404).json({ error: 'not_found' });
    const user = u[0];
    delete user.password_hash; // legacy სვეტი — აღარ გამოიყენება, პასუხში არ გავუშვათ

    const { rows: transactions } = await db.query(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
      [req.params.id]
    );

    res.json({ user, transactions });
  } catch (err) {
    console.error('admin user detail error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/admin/users/:id/adjust-balance  — მანუალური ბალანსის
// კორექცია (Manual Wallet Control). amount დადებითია დასამატებლად,
// უარყოფითია გამოსაკლებად. note სავალდებულოა — აუდიტისთვის ინახება
// transactions.description-ში (+ admin_note-ში ვინ შეასრულა).
// ══════════════════════════════════════════════════════════════
router.put('/users/:id/adjust-balance', async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const note   = (req.body.note || '').trim();

    if (!amount || !Number.isFinite(amount)) {
      return res.status(400).json({ error: 'invalid_amount' });
    }
    if (!note) {
      return res.status(400).json({ error: 'note_required', message: 'კორექციის მიზეზი სავალდებულოა' });
    }

    const { rows: u } = await db.query('SELECT balance_gel FROM users WHERE id=$1', [req.params.id]);
    if (!u.length) return res.status(404).json({ error: 'not_found' });

    if (amount < 0 && Number(u[0].balance_gel) < Math.abs(amount)) {
      return res.status(402).json({ error: 'insufficient_balance', available: u[0].balance_gel });
    }

    await db.transaction(async (client) => {
      await client.query(
        'UPDATE users SET balance_gel = balance_gel + $1 WHERE id=$2',
        [amount, req.params.id]
      );
      await client.query(
        `INSERT INTO transactions(user_id, type, amount_gel, description, status, admin_note)
         VALUES($1,'admin_adjustment',$2,$3,'completed',$4)`,
        [req.params.id, amount,
         amount > 0 ? `ადმინის მიერ ბალანსზე დამატება: ${note}` : `ადმინის მიერ ბალანსიდან ჩამოჭრა: ${note}`,
         `მოქმედი ადმინი: ${req.user.email || req.user.id}`]
      );
    });

    res.json({ ok: true });

    (async () => {
      try {
        await push.sendToUser(req.params.id, {
          title: amount > 0 ? '💰 ბალანსზე დაემატა თანხა' : '💸 ბალანსიდან ჩამოიჭრა თანხა',
          body: `${amount > 0 ? '+' : ''}₾${amount.toFixed(2)} — ${note}`,
          url: '/?page=wallet',
          tag: `admin-adjust-${Date.now()}`,
        });
      } catch (e) { console.error('adjust-balance push error:', e.message); }
    })();
  } catch (err) {
    console.error('admin adjust-balance error:', err.message);
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
    // ══════════════════════════════════════════════════════════════
    // ⚠️ FIX (HIGH — TOCTOU race condition): status='pending' შემოწმება
    // აქამდე ხდებოდა ტრანზაქციის *დაწყებამდე*, ცალკე db.query()-ში.
    // ადმინის ორმაგმა დაწკაპუნებამ ან network retry-მ ორივე request
    // შეეძლო წაეკითხა row ჯერ კიდევ 'pending' სტატუსით, სანამ პირველი
    // UPDATE დასრულდებოდა — შედეგად ბალანსზე ორჯერ დაერიცხებოდა
    // იგივე თანხა.
    //
    // ფიქსი: SELECT ... FOR UPDATE OF t ტრანზაქციის შიგნით ჯერ ბლოკავს
    // ამ transaction row-ს, მხოლოდ ᲛᲔᲠᲔ ხელახლა ამოწმებს status='pending'-ს.
    // მეორე პარალელური request ლოქზე დაელოდება პირველის commit-ს და
    // შემდეგ უკვე ხედავს status='completed'-ს — 404-ით ჩერდება, ორმაგი
    // დარიცხვის გარეშე.
    // ══════════════════════════════════════════════════════════════
    let txRow, gross, referralResult = { granted: false };
    try {
      await db.transaction(async (client) => {
        // Join users, რომ email/username ერთი მოთხოვნით მოგვქონდეს —
        // საჭიროა დადასტურების დეტალური წერილისთვის (mailer.sendDepositApprovedEmail).
        // FOR UPDATE OF t — მხოლოდ transactions row იბლოკება (users
        // row-ს აქ მხოლოდ წაკითხვა სჭირდება).
        const { rows: tx } = await client.query(
          `SELECT t.*, u.email, u.username, u.notif_email
           FROM transactions t JOIN users u ON u.id = t.user_id
           WHERE t.id=$1 AND t.type='deposit'
           FOR UPDATE OF t`,
          [req.params.id]
        );
        if (!tx.length) {
          const notFoundErr = new Error('not_found');
          notFoundErr.code = 'NOT_FOUND';
          throw notFoundErr;
        }
        // ── ლოქის ᲨᲘᲒᲜᲘᲗ ხელახალი, ატომური სტატუსის შემოწმება ──
        if (tx[0].status !== 'pending') {
          const notPendingErr = new Error('not_pending');
          notPendingErr.code = 'NOT_FOUND'; // მომხმ-სთვის იგივე 404 — არ ავლენს რომ უკვე დამუშავდა
          throw notPendingErr;
        }

        txRow = tx[0];

        // ⚠️ დეპოზიტზე საკომისიო არ არის აღებული (0%) — გადაწყვეტილება:
        // თანხის შემოტანა თავისთავად ღირებულების შექმნა არაა (ინდუსტრიის
        // სტანდარტი — Steam Market/G2G/Eldorado არც ერთი არ იღებს deposit fee-ს).
        // 5%-იანი საკომისია რჩება მხოლოდ იქ, სადაც რეალურად აქტიური ტრანზაქციაა:
        // გაყიდვა (orders.js), გამოტანა (wallet.js), VIP (listings.js).
        gross = Number(txRow.amount_gel);

        await client.query(
          `UPDATE transactions SET
             status='completed',
             net_amount_gel=$2, commission_fee_gel=0, gross_amount_gel=$3
           WHERE id=$1`,
          [req.params.id, gross, gross]
        );
        await client.query(
          'UPDATE users SET balance_gel=balance_gel+$1 WHERE id=$2',
          [gross, txRow.user_id]
        );

        // ── REFERRAL: "პირველი დეპოზიტი" ჯილდოს ტრიგერი ზუსტად აქ ცხადდება —
        // ეს არის ის ერთადერთი წერტილი, სადაც დეპოზიტის ფული რეალურად შედის
        // მომხმარებლის ბალანსზე (ადმინის მიერ დადასტურებული ბანკის გადარიცხვა).
        // wallet.js-ის POST /deposit მხოლოდ 'pending' მოთხოვნას ქმნის და
        // არასდროს არ უნდა გაააქტიუროს ბონუსი.
        //
        // ── ₾10-ის ზღვარი (DEPOSIT_REWARD_THRESHOLD_GEL) მოწმდება
        // referral.js-ის შიგნით — აქ უბრალოდ ვაწვდით რეალურ დადასტ.
        // თანხას (gross), რომ ფუნქციამ თავად გადაწყვიტოს კვალიფიც. ──
        referralResult = await referral.triggerReferralReward(client, txRow.user_id, 'deposit', gross);
      });
    } catch (txErr) {
      if (txErr.code === 'NOT_FOUND') return res.status(404).json({ error: 'not_found' });
      throw txErr;
    }

    // push notification მომხმარებელს
    const push = require('../utils/push');
    await push.sendToUser(txRow.user_id, {
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
        tag: `referral-deposit-${txRow.user_id}`,
      }).catch(e => console.error('referral push (deposit) error:', e.message));
    }

    // დეტალური დადასტურების წერილი — UI-ში (საფულის ტრანზაქციების
    // ისტორია) მხოლოდ სუფთა "დამტკიცებულია" ბეჯი ჩანს (იხ. frontend
    // loadTransactions()), დეტალები კი პირდაპირ ელ-ფოსტაზე იგზავნება.
    mailer.sendDepositApprovedEmail(txRow, gross, txRow.external_ref)
      .catch(e => console.error('deposit approved email:', e.message));

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/deposits/:id/reject  — deposit უარყოფა
router.post('/deposits/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason = '' } = req.body;
    // Join users — email/username ერთი მოთხოვნით, უარყოფის დეტალური
    // წერილისთვის (mailer.sendDepositRejectedEmail).
    const { rows: tx } = await db.query(
      `SELECT t.*, u.email, u.username, u.notif_email
       FROM transactions t JOIN users u ON u.id = t.user_id
       WHERE t.id=$1 AND t.type='deposit' AND t.status='pending'`,
      [req.params.id]
    );
    if (!tx.length) return res.status(404).json({ error: 'not_found' });

    // ⚠️ UI FIX: ადმინის დეტალური მიზეზი აღარ ერწყმის description-ს —
    // ეს ველი პირდაპირ ჩანდა საფულის ტრანზაქციების ისტორიაში
    // (არაპროფესიონალურად/დამაბნევლად გამოიყურებოდა). description
    // უცვლელი რჩება (მხოლოდ ტიპის სუფთა ლეიბლი), დეტალური მიზეზი
    // ცალკე admin_note სვეტში ინახება (შიდა/support არქივისთვის) და
    // სრულად ეგზავნება მომხმარებელს ელ-ფოსტით ქვემოთ.
    await db.query(
      "UPDATE transactions SET status='failed', admin_note=$1 WHERE id=$2",
      [reason || null, req.params.id]
    );

    const push = require('../utils/push');
    await push.sendToUser(tx[0].user_id, {
      title: '❌ შეტანა უარყოფილია',
      body: reason || 'გადარიცხვა ვერ დადასტ. — დაგვიკავშირდი',
      url: '/?page=wallet',
      tag: `deposit-reject-${req.params.id}`,
    });

    // დეტალური უარყოფის მიზეზი — მხოლოდ ელ-ფოსტით (არა UI-ში)
    mailer.sendDepositRejectedEmail(tx[0], tx[0].amount_gel, reason, tx[0].external_ref)
      .catch(e => console.error('deposit rejected email:', e.message));

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
    // ══════════════════════════════════════════════════════════════
    // ⚠️ FIX (HIGH — TOCTOU race condition): იგივე პრობლემა და იგივე
    // ფიქსი, რაც deposits/:id/confirm-ში ზემოთ — status='pending'
    // შემოწმება გადატანილია ტრანზაქციის შიგნით, FOR UPDATE OF t ლოქის
    // ᲨᲘᲒᲜᲘᲗ, რომ ორმაგი დაწკაპუნება/request-ის გამეორება ორჯერ ვერ
    // ჩაითვალოს გამოტანა platform-ის საკომისიოში.
    // ══════════════════════════════════════════════════════════════
    let txRow, fee, net;
    try {
      await db.transaction(async (client) => {
        const { rows: tx } = await client.query(
          `SELECT t.*, u.email, u.username, u.notif_email
           FROM transactions t JOIN users u ON u.id = t.user_id
           WHERE t.id=$1 AND t.type='withdrawal'
           FOR UPDATE OF t`,
          [req.params.id]
        );
        if (!tx.length) {
          const notFoundErr = new Error('not_found');
          notFoundErr.code = 'NOT_FOUND';
          throw notFoundErr;
        }
        if (tx[0].status !== 'pending') {
          const notPendingErr = new Error('not_pending');
          notPendingErr.code = 'NOT_FOUND';
          throw notPendingErr;
        }

        txRow = tx[0];

        // საკომისიო უკვე გამოთვლილია მოთხოვნის დროს (wallet.js) და შენახულია
        // commission_fee_gel-ში — აქ მხოლოდ ვაქტ. ვხდით პლატფორმის შემოსავალში,
        // რომ უარყოფის შემთხვევაში (reject) არასდროს დარჩეს "ბრჭყალებში" საკომისიო.
        fee = Number(txRow.commission_fee_gel) || 0;
        net = txRow.net_amount_gel != null
          ? Number(txRow.net_amount_gel)
          : Math.abs(Number(txRow.amount_gel));

        await client.query(
          "UPDATE transactions SET status='completed' WHERE id=$1", [req.params.id]
        );
        if (fee > 0) await ledger.recordPlatformFee(client, fee);
      });
    } catch (txErr) {
      if (txErr.code === 'NOT_FOUND') return res.status(404).json({ error: 'not_found' });
      throw txErr;
    }

    const push = require('../utils/push');
    await push.sendToUser(txRow.user_id, {
      title: '✅ გამოტანა დადასტ.',
      body: `₾${net.toFixed(2)} გაიგზავნა შენს ანგარიშზე`,
      url: '/?page=wallet',
      tag: `withdrawal-${req.params.id}`,
    });

    mailer.sendWithdrawApprovedEmail(txRow, net)
      .catch(e => console.error('withdrawal approved email:', e.message));

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
      `SELECT t.*, u.email, u.username, u.notif_email
       FROM transactions t JOIN users u ON u.id = t.user_id
       WHERE t.id=$1 AND t.type='withdrawal' AND t.status='pending'`,
      [req.params.id]
    );
    if (!tx.length) return res.status(404).json({ error: 'not_found' });

    const refundAmount = Math.abs(Number(tx[0].amount_gel));

    await db.transaction(async (client) => {
      await client.query(
        "UPDATE transactions SET status='failed', admin_note=$1 WHERE id=$2",
        [reason || null, req.params.id]
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

    // დეტალური უარყოფის მიზეზი — მხოლოდ ელ-ფოსტით (არა UI-ში)
    mailer.sendWithdrawRejectedEmail(tx[0], refundAmount, reason)
      .catch(e => console.error('withdrawal rejected email:', e.message));

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// CATEGORY MANAGEMENT — დინამიური კატეგორიების მართვა
// (საჯარო წაკითხვისთვის იხ. GET /api/listings/categories)
// ══════════════════════════════════════════════════════════════

// GET /api/admin/categories  — ყველა კატეგორია (არააქტ.-ის ჩათვლით)
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM categories ORDER BY sort_order ASC, name_ka ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/categories  — ახალი კატეგორიის დამატება
router.post('/categories', async (req, res) => {
  try {
    const { slug, name_ka, icon, sort_order } = req.body;
    if (!slug || !name_ka) return res.status(400).json({ error: 'slug_and_name_required' });
    if (!/^[a-z0-9_-]{2,30}$/.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug — მხოლოდ ლათინური ასოები, ციფრები, - და _' });
    }

    const { rows } = await db.query(
      `INSERT INTO categories(slug, name_ka, icon, sort_order) VALUES($1,$2,$3,$4) RETURNING *`,
      [slug.trim().toLowerCase(), name_ka.trim(), icon || null, Number(sort_order) || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug_already_exists' });
    console.error('category create error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// PUT /api/admin/categories/:id  — რედაქტირება (სახელი/აიკონი/რიგი/აქტიურობა)
router.put('/categories/:id', async (req, res) => {
  try {
    const { name_ka, icon, sort_order, is_active } = req.body;
    const { rows } = await db.query(
      `UPDATE categories SET
         name_ka    = COALESCE($1, name_ka),
         icon       = COALESCE($2, icon),
         sort_order = COALESCE($3, sort_order),
         is_active  = COALESCE($4, is_active),
         updated_at = NOW()
       WHERE id=$5 RETURNING *`,
      [name_ka || null, icon || null,
       sort_order !== undefined ? Number(sort_order) : null,
       is_active !== undefined ? !!is_active : null,
       req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('category update error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/admin/categories/:id  — წაშლა (მხოლოდ თუ არცერთი
// განცხადება არ იყენებს ამ კატეგორიას — წინააღმდეგ შემთხვევაში
// შესთავაზეთ admin-ს დეაქტივაცია PUT-ით (is_active=false) წაშლის ნაცვლად)
router.delete('/categories/:id', async (req, res) => {
  try {
    const { rows: cat } = await db.query('SELECT slug FROM categories WHERE id=$1', [req.params.id]);
    if (!cat.length) return res.status(404).json({ error: 'not_found' });

    const { rows: usage } = await db.query(
      'SELECT COUNT(*) AS n FROM listings WHERE category=$1', [cat[0].slug]
    );
    if (Number(usage[0].n) > 0) {
      return res.status(409).json({
        error: 'category_in_use',
        message: `ამ კატეგორიას იყენებს ${usage[0].n} განცხადება — წაშლა შეუძლებელია, გამორთეთ (is_active=false) ნაცვლად`,
        listings_count: Number(usage[0].n),
      });
    }

    await db.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('category delete error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GLOBAL ANNOUNCEMENTS — საიტის მასშტაბით შეტყობინებები
// (საჯარო წაკითხვისთვის იხ. GET /api/stats/announcements)
// ══════════════════════════════════════════════════════════════

// GET /api/admin/announcements  — ყველა ანონსი (არააქტ.-ის ჩათვლით)
router.get('/announcements', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT a.*, u.username AS created_by_username
      FROM announcements a
      LEFT JOIN users u ON u.id = a.created_by
      ORDER BY a.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/announcements  — ახალი ანონსის შექმნა + დაუყოვნებელი
// push ყველა მომხმარებელზე ვისაც push subscription აქვს რეგისტრირებული.
// ⚠️ ვისაც push subscription არ აქვს, მათთვის ეს ბანერად ჩანს მთავარ
// საიტზე შემდეგი GET /api/stats/announcements-ის დროს — push მხოლოდ
// დამატებითი, დაუყოვნებელი არხია, არა ერთადერთი.
router.post('/announcements', async (req, res) => {
  try {
    const { title, body, level = 'info', expires_at } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title_and_body_required' });
    if (!['info', 'warning', 'critical'].includes(level)) {
      return res.status(400).json({ error: 'invalid_level' });
    }

    const { rows } = await db.query(
      `INSERT INTO announcements(title, body, level, created_by, expires_at)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [title.trim(), body.trim(), level, req.user.id, expires_at || null]
    );
    const announcement = rows[0];
    res.status(201).json(announcement);

    // ── ყველა subscribed მომხმარებელზე push — async, პასუხს არ აყოვნებს ──
    (async () => {
      try {
        const { rows: subs } = await db.query('SELECT DISTINCT user_id FROM push_subscriptions');
        await Promise.all(subs.map(s => push.sendToUser(s.user_id, {
          title: `📢 ${announcement.title}`,
          body: announcement.body.slice(0, 140),
          url: '/',
          tag: `announcement-${announcement.id}`,
        }).catch(() => {})));
      } catch (e) { console.error('announcement broadcast error:', e.message); }
    })();
  } catch (err) {
    console.error('announcement create error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// PUT /api/admin/announcements/:id  — რედაქტირება/დეაქტივაცია
router.put('/announcements/:id', async (req, res) => {
  try {
    const { title, body, level, is_active, expires_at } = req.body;
    if (level !== undefined && !['info', 'warning', 'critical'].includes(level)) {
      return res.status(400).json({ error: 'invalid_level' });
    }
    const { rows } = await db.query(
      `UPDATE announcements SET
         title      = COALESCE($1, title),
         body       = COALESCE($2, body),
         level      = COALESCE($3, level),
         is_active  = COALESCE($4, is_active),
         expires_at = COALESCE($5, expires_at)
       WHERE id=$6 RETURNING *`,
      [title || null, body || null, level || null,
       is_active !== undefined ? !!is_active : null,
       expires_at || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('announcement update error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/admin/announcements/:id
router.delete('/announcements/:id', async (req, res) => {
  try {
    const { rows } = await db.query('DELETE FROM announcements WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/referrals/leaderboard  — Admin-Only Referral Leaderboard
//
// ⚠️ ეს route უკვე დაცულია admin-ით — router.use(requireAuth,
// requireAdmin) ფაილის თავშია განსაზღვრული (ხაზი ~30) და ყველა
// admin.js-ის route-ზე მოქმედებს. ცალკე middleware აქ არ სჭირდება,
// მაგრამ ვინც ცალკე გაიტანს ამ route-ს სხვა ფაილში, აუცილებლად
// უნდა შემოხვიოს იმავე ორი middleware-ით — ეს პანელი არასდროს
// არ უნდა იყოს public-ად ხელმისაწვდომი.
//
// კოდის/ბმულის გენერაცია თავად უკვე არსებობს (src/utils/referral.js:
// ensureReferralCode) და ჩართულია რეგისტრაციის ორივე ნაკადში
// (auth.js POST /verify-otp და GET /google/callback) — თითო
// მომხმარებელს აქვს უნიკალური `REF-XXXXXX` კოდი, ბმული frontend-ზე
// შედგება როგორც `${FRONTEND_URL}/?ref=${referral_code}`. აქ მხოლოდ
// რანჟირების/სტატისტიკის ნაწილია დამატებული.
//
// რანჟირება: მხოლოდ ის მომხმარებლები ჩნდებიან, ვისაც ერთი მოწვეული
// მაინც ჰყავს (INNER JOIN). "წარმატებული რეგისტრაცია" == users.referred_by
// მიბმულია (ეს მხოლოდ წარმატებული OTP-verify/Google callback-ის დროს
// ხდება — იხ. auth.js — ანუ ნახევრადშესრულებული/გაუქმებული
// რეგისტრაცია საერთოდ ვერასდროს "ითვლება"). ოფციური `since` query
// param საშუალებას აძლევს ადმინს დაინახოს მხოლოდ კონკრეტული პერიოდის
// (მაგ. ამ თვის) მოწვევები — countered date is the *referred user's*
// registration date, არა რეფერერის.
// ══════════════════════════════════════════════════════════════
router.get('/referrals/leaderboard', async (req, res) => {
  try {
    const { page = 1, limit = 25, since } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const params = [];
    let dateFilter = '';
    if (since) {
      params.push(since);
      dateFilter = `AND ru.created_at >= $${params.length}`;
    }
    params.push(Number(limit), offset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const { rows } = await db.query(`
      SELECT
        u.id, u.username, u.display_name, u.avatar_url, u.email,
        u.referral_code, u.referral_earnings_gel, u.created_at AS joined_at,
        COUNT(ru.id) AS total_referrals,
        COUNT(ru.id) FILTER (
          WHERE ru.has_triggered_first_deposit_reward
             OR ru.has_triggered_first_purchase_reward
        ) AS converted_referrals,
        RANK() OVER (ORDER BY COUNT(ru.id) DESC) AS rank
      FROM users u
      JOIN users ru ON ru.referred_by = u.id ${dateFilter}
      GROUP BY u.id
      ORDER BY total_referrals DESC, u.referral_earnings_gel DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, params);

    const { rows: cnt } = await db.query(
      `SELECT COUNT(DISTINCT referred_by) AS n FROM users WHERE referred_by IS NOT NULL`
    );

    res.json({
      leaderboard: rows,
      total_referrers: Number(cnt[0].n),
      page: Number(page),
      pages: Math.ceil(Number(cnt[0].n) / Number(limit)) || 1,
    });
  } catch (err) {
    console.error('admin referral leaderboard error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/chat/flags  — Anti-Scam ავტ.-მოდერაციის ჟურნალი
// (ბმულების/ტელეფონების/bypass საკვანძო სიტყვების ავტ. დაფარვის
// შემთხვევები pre-purchase/order ჩატში — იხ. src/utils/moderation.js
// და src/routes/chat.js). Watchtower-ს აძლევს სწრაფ ვიზუალურ
// წვდომას, ვინ ცდილობს ვაჭრობის Escrow-ს გვერდის ავლას.
// ══════════════════════════════════════════════════════════════
router.get('/chat/flags', async (req, res) => {
  try {
    const { page = 1, limit = 30, sender_id } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const conditions = [];
    const params = [];
    let p = 1;
    if (sender_id) { conditions.push(`f.sender_id = $${p++}`); params.push(sender_id); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countParams = params.slice();
    params.push(Number(limit), offset);

    const { rows } = await db.query(`
      SELECT
        f.id, f.categories, f.redacted_snippet, f.created_at,
        f.room_id, f.message_id, f.sender_id,
        u.username AS sender_username, u.display_name AS sender_display_name,
        u.role AS sender_role
      FROM message_flags f
      JOIN users u ON u.id = f.sender_id
      ${where}
      ORDER BY f.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `, params);

    const { rows: cnt } = await db.query(
      `SELECT COUNT(*) AS n FROM message_flags f ${where}`, countParams
    );

    res.json({
      flags: rows,
      total: Number(cnt[0].n),
      page: Number(page),
      pages: Math.ceil(Number(cnt[0].n) / Number(limit)) || 1,
    });
  } catch (err) {
    console.error('admin chat flags error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
