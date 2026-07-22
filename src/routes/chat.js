// src/routes/chat.js
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const push    = require('../utils/push');
const router  = express.Router();

// ── NO-CACHE — ჩატის შეტყობინებები რეალურ დროში იცვლება; ბრაუზერს/
// პროქსის ვუკრძალავთ ძველი შეტყობინებების სიის დაკეშვას.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ══════════════════════════════════════════════════════════════
// GET /api/chat/rooms  — ჩემი ოთახები
// ══════════════════════════════════════════════════════════════
router.get('/rooms', requireAuth, async (req, res) => {
  try {
    // ⚠️ order-ზე JOIN → LEFT JOIN გახდა: ადმინის სისტ. შეტყობინებების
    // ოთახებს (იხ. sendAdminNotice ქვემოთ) order_id არ გააჩნია — INNER
    // JOIN-ით ეს ოთახები საერთოდ არ გამოჩნდებოდა სიაში.
    const { rows } = await db.query(`
      SELECT
        r.*,
        CASE WHEN r.order_id IS NULL THEN 'admin_notice' ELSE 'order' END AS room_type,
        o.status        AS order_status,
        o.amount_gel,
        o.escrow_status,
        COALESCE(l.title, 'ადმინისტრაციის შეტყობინებები') AS listing_title,
        l.game,
        ua.username     AS participant_a_name,
        ua.avatar_url   AS participant_a_avatar,
        ua.is_verified_seller AS participant_a_verified,
        ub.username     AS participant_b_name,
        ub.avatar_url   AS participant_b_avatar,
        ub.is_verified_seller AS participant_b_verified,
        (SELECT content FROM messages m
         WHERE m.room_id=r.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m
         WHERE m.room_id=r.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
        (SELECT COUNT(*) FROM messages m
         WHERE m.room_id=r.id AND m.sender_id!=$1 AND m.is_read=FALSE) AS unread_count
      FROM chat_rooms r
      LEFT JOIN orders o   ON o.id=r.order_id
      LEFT JOIN listings l ON l.id=o.listing_id
      JOIN users ua   ON ua.id=r.participant_a
      JOIN users ub   ON ub.id=r.participant_b
      WHERE r.participant_a=$1 OR r.participant_b=$1
      ORDER BY last_message_at DESC NULLS LAST
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/chat/rooms/:id/messages  — შეტყობინებების ისტ.
// ══════════════════════════════════════════════════════════════
router.get('/rooms/:id/messages', requireAuth, async (req, res) => {
  try {
    const { rows: room } = await db.query(
      'SELECT * FROM chat_rooms WHERE id=$1', [req.params.id]
    );
    if (!room.length) return res.status(404).json({ error: 'not_found' });
    const r = room[0];
    if (r.participant_a !== req.user.id && r.participant_b !== req.user.id)
      return res.status(403).json({ error: 'forbidden' });

    const { page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const { rows } = await db.query(`
      SELECT m.*, u.username AS sender_username, u.avatar_url AS sender_avatar
      FROM messages m
      JOIN users u ON u.id=m.sender_id
      WHERE m.room_id=$1
      ORDER BY m.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.params.id, Number(limit), offset]);

    // წაკ. მარ.
    await db.query(
      'UPDATE messages SET is_read=TRUE WHERE room_id=$1 AND sender_id!=$2 AND is_read=FALSE',
      [req.params.id, req.user.id]
    );

    res.json(rows.reverse());
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/chat/support  — "მხარდაჭერა" — მუდმივი ჩატი ადმინთან
//
// ნებისმ. ავტორიზ. მომხმარებელს შეუძლია პირდაპ. მიწერა Admin-ს — იყენებს
// იმავე getOrCreateAdminRoom() infrastructure-ს, რასაც listing-ის
// წაშლის/უარყოფის სისტ. შეტყობინებები იყენებენ (იხ. sendAdminNotice
// ქვემოთ) — ასე ორივე ტიპის შეტყობინება (ადმინის შეტყ. + user-ის
// მხარდაჭ. კითხვა) ერთსა და იმავე მუდმ. ოთახში ხვდება. იდემპოტენტურია —
// თუ ოთახი უკვე არსებობს, უბრალოდ მას აბრუნებს (არ ქმნის დუბლიკატს). ──
// ══════════════════════════════════════════════════════════════
router.get('/support', requireAuth, async (req, res) => {
  try {
    const room = await getOrCreateAdminRoom(req.user.id);
    const adminId = room.participant_a === req.user.id ? room.participant_b : room.participant_a;

    const { rows } = await db.query(
      'SELECT username, display_name, avatar_url FROM users WHERE id=$1', [adminId]
    );
    const admin = rows[0] || {};

    res.json({
      id: room.id,
      participant_a: room.participant_a,
      participant_b: room.participant_b,
      order_id: null,
      admin_name:   admin.display_name || admin.username || 'ადმინისტრაცია',
      admin_avatar: admin.avatar_url || null,
    });
  } catch (err) {
    console.error('support room error:', err.message);
    if (err.message === 'SUPER_ADMIN_EMAIL_not_configured' || err.message === 'super_admin_user_not_found') {
      return res.status(503).json({ error: 'support_unavailable' });
    }
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/chat/rooms/:id/messages  — HTTP fallback (WS-ის გარდა)
// ══════════════════════════════════════════════════════════════
router.post('/rooms/:id/messages', requireAuth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim())
      return res.status(400).json({ error: 'empty_message' });

    const { rows: room } = await db.query(
      'SELECT * FROM chat_rooms WHERE id=$1', [req.params.id]
    );
    if (!room.length) return res.status(404).json({ error: 'not_found' });
    const r = room[0];
    if (r.participant_a !== req.user.id && r.participant_b !== req.user.id)
      return res.status(403).json({ error: 'forbidden' });

    const { rows } = await db.query(`
      INSERT INTO messages(room_id,sender_id,content)
      VALUES($1,$2,$3)
      RETURNING *
    `, [req.params.id, req.user.id, content.trim()]);

    // WS-ით დაკავშირებულ მხარეებს რეალურ დროში გაგზავნა (თუ ვინმე online-ია)
    broadcastMessageToRoom(req.params.id, rows[0]);

    // push შეტყობ. — მეორე მონაწილეს, თუ ოთახში online არაა
    const recipientId = r.participant_a === req.user.id ? r.participant_b : r.participant_a;
    notifyChatMessage(req.params.id, recipientId, req.user, content.trim()).catch(() => {});

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GLOBAL CHAT — ერთი საერთო ოთახი, ხილული საიტის ყველა გვერდიდან
// (frontend: gamer-market-ge.html-ის floating widget). ცალკეა
// chat_rooms/messages-ის 1:1 სისტემისგან — საკუთარი global_messages
// ცხრილი აქვს (იხ. setup.js migrations), auth მხოლოდ წერაზეა
// სავალდებულო, კითხვა სტუმარსაც შეუძლია.
// ══════════════════════════════════════════════════════════════

// 30-წამიანი slow-mode — server-side დაცვა. Client-ის countdown
// მხოლოდ UX-ისთვისაა; აქაც ცალკე მოწმდება, თორემ პირდაპ. API
// გამოძახებით client-ის ვადის გვერდის ავლა იქნებოდა შესაძლებელი.
// In-memory Map-ია (არა DB) განზრახ — მსუბუქი, high-frequency
// შემოწმებაა და დაკარგვა restart-ზე უვნებელია (უარეს შემთხვევაში
// ვინმეს უბრალოდ ერთი დამატებითი შეტყ. გაეშვება).
const GLOBAL_CHAT_COOLDOWN_MS = 30 * 1000;
const GLOBAL_CHAT_MAX_LEN     = 500;
const lastGlobalMsgAt = new Map(); // userId → ბოლო შეტყ.-ის timestamp

// მოწონებული "sender" ინფოს JOIN — ერთხელ დაწერილი, სამივე ადგილას
// (GET history, POST fallback, WS handler) გამოსაყენებელი.
async function fetchGlobalSender(userId) {
  const { rows } = await db.query(`
    SELECT u.username, u.display_name, u.avatar_url, u.role,
      (u.is_vip AND u.vip_expires_at IS NOT NULL AND u.vip_expires_at > NOW()) AS is_vip,
      COALESCE(ss.avg_rating, 0)   AS avg_rating,
      COALESCE(ss.review_count, 0) AS review_count
    FROM users u
    LEFT JOIN seller_stats ss ON ss.seller_id = u.id
    WHERE u.id=$1
  `, [userId]);
  return rows[0] || {};
}

// ══════════════════════════════════════════════════════════════
// GET /api/chat/global/messages  — საჯარო ისტორია (auth არ სჭირდება)
// ══════════════════════════════════════════════════════════════
router.get('/global/messages', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const { rows } = await db.query(`
      SELECT
        m.id, m.sender_id, m.content, m.created_at,
        u.username, u.display_name, u.avatar_url, u.role,
        (u.is_vip AND u.vip_expires_at IS NOT NULL AND u.vip_expires_at > NOW()) AS is_vip,
        COALESCE(ss.avg_rating, 0)   AS avg_rating,
        COALESCE(ss.review_count, 0) AS review_count
      FROM global_messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN seller_stats ss ON ss.seller_id = u.id
      ORDER BY m.created_at DESC
      LIMIT $1
    `, [limit]);
    res.json(rows.reverse());
  } catch (err) {
    console.error('global chat history error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/chat/global/messages  — HTTP fallback (WS-ის გარდა)
// ══════════════════════════════════════════════════════════════
router.post('/global/messages', requireAuth, async (req, res) => {
  try {
    const raw = (req.body.content || '').trim();
    if (!raw) return res.status(400).json({ error: 'empty_message' });
    if (raw.length > GLOBAL_CHAT_MAX_LEN) return res.status(400).json({ error: 'too_long' });

    const last    = lastGlobalMsgAt.get(req.user.id) || 0;
    const elapsed = Date.now() - last;
    if (elapsed < GLOBAL_CHAT_COOLDOWN_MS) {
      return res.status(429).json({ error: 'slow_mode', retry_after_ms: GLOBAL_CHAT_COOLDOWN_MS - elapsed });
    }
    lastGlobalMsgAt.set(req.user.id, Date.now());

    const { rows } = await db.query(
      'INSERT INTO global_messages(sender_id,content) VALUES($1,$2) RETURNING *',
      [req.user.id, raw]
    );
    const sender   = await fetchGlobalSender(req.user.id);
    const enriched = { ...rows[0], ...sender };

    broadcastGlobalMessage(enriched);
    res.status(201).json(enriched);
  } catch (err) {
    console.error('global chat send error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;

// ══════════════════════════════════════════════════════════════
// WebSocket სერვერი  — src/ws/chat.js
// ══════════════════════════════════════════════════════════════
// გამოყენება: setupWebSocket(httpServer)

const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

// roomId → Set of {ws, userId}
const rooms = new Map();

// ── გამოწერების შემოწ. — push მხოლოდ მაშინ, თუ მიმღები ამ ოთახში online არაა ──
async function notifyChatMessage(roomId, recipientId, sender, content) {
  const conns = rooms.get(roomId);
  const recipientOnline = conns && [...conns].some(c => c.userId === recipientId && c.ws.readyState === 1);
  if (recipientOnline) return; // chat ღია აქვს — toast საჭირო არაა

  const senderName = sender.display_name || sender.username || 'მომხმარებელი';
  const preview = content.length > 80 ? content.slice(0, 80) + '…' : content;

  await push.sendToUser(recipientId, {
    title: `💬 ${senderName}`,
    body: preview,
    url: `/?chat=${roomId}`,
    tag: `chat-${roomId}`,
  });
}

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/chat' });

  // Ping/Pong — კავშირი ცოცხალი დარჩეს
  const pingInterval = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    });
  }, 25000); // 25 წამში ერთხელ

  wss.on('close', () => clearInterval(pingInterval));

  wss.on('connection', async (ws, req) => {
    const url    = new URL(req.url, `http://localhost`);
    const token  = url.searchParams.get('token');
    const roomId = url.searchParams.get('room');

    // Auth შემოწ.
    let userId;
    try {
      const p = jwt.verify(token, process.env.JWT_SECRET);
      userId  = p.sub;
    } catch {
      ws.close(4001, 'unauthorized'); return;
    }

    // ოთახში წვდომის შემოწ. — 'global' არის საიტის საერთო ჩატის
    // სპეც. pseudo-room ID (იხ. GLOBAL CHAT სექცია ზემოთ): მასზე
    // ნებისმ. ავტორიზებულ მომხმარებელს აქვს წვდომა, chat_rooms-ში
    // საერთოდ არ არსებობს, ამიტომ 1:1 ოთახის owner-შემოწმებას ვტოვებთ.
    if (roomId !== 'global') {
      try {
        const { rows } = await db.query(
          'SELECT id FROM chat_rooms WHERE id=$1 AND (participant_a=$2 OR participant_b=$2)',
          [roomId, userId]
        );
        if (!rows.length) { ws.close(4003, 'forbidden'); return; }
      } catch { ws.close(4000, 'error'); return; }
    }

    // ოთახში დამ.
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const conn = { ws, userId };
    rooms.get(roomId).add(conn);

    ws.on('message', async (raw) => {
      try {
        const { content } = JSON.parse(raw.toString());
        if (!content?.trim()) return;

        // ── GLOBAL CHAT — ცალკე დამუშავება: cooldown, global_messages
        // ცხრილი, ბრადქასთი მთელ 'global' ოთახზე. push/1:1 ლოგიკას
        // საერთოდ არ ეხება. ──
        if (roomId === 'global') {
          const trimmed = content.trim().slice(0, GLOBAL_CHAT_MAX_LEN);

          const last    = lastGlobalMsgAt.get(userId) || 0;
          const elapsed = Date.now() - last;
          if (elapsed < GLOBAL_CHAT_COOLDOWN_MS) {
            ws.send(JSON.stringify({ type: 'slow_mode', retry_after_ms: GLOBAL_CHAT_COOLDOWN_MS - elapsed }));
            return;
          }
          lastGlobalMsgAt.set(userId, Date.now());

          const { rows } = await db.query(
            'INSERT INTO global_messages(sender_id,content) VALUES($1,$2) RETURNING *',
            [userId, trimmed]
          );
          const sender   = await fetchGlobalSender(userId);
          const enriched = { ...rows[0], ...sender };

          broadcastGlobalMessage(enriched);
          return;
        }

        // DB-ში შენ.
        const { rows } = await db.query(
          'INSERT INTO messages(room_id,sender_id,content) VALUES($1,$2,$3) RETURNING *',
          [roomId, userId, content.trim()]
        );
        const msg = rows[0];

        // ყველა ოთახის წევრს გაგ.
        broadcastMessageToRoom(roomId, msg);

        // push შეტყობ. — მეორე მონაწ-ს, თუ ის ოთახში online არაა
        try {
          const { rows: roomRows } = await db.query('SELECT * FROM chat_rooms WHERE id=$1', [roomId]);
          if (roomRows.length) {
            const rr = roomRows[0];
            const recipientId = rr.participant_a === userId ? rr.participant_b : rr.participant_a;
            const { rows: senderRows } = await db.query('SELECT username, display_name FROM users WHERE id=$1', [userId]);
            await notifyChatMessage(roomId, recipientId, senderRows[0] || {}, msg.content);
          }
        } catch (e) { /* push შეცდომა — chat-ს არ ვაჩერებთ */ }
      } catch (err) {
        console.error('ws message error:', err.message);
      }
    });

    ws.on('close', () => {
      rooms.get(roomId)?.delete(conn);
      if (rooms.get(roomId)?.size === 0) rooms.delete(roomId);
    });

    ws.on('pong', () => {
      // კავშირი ცოცხალია
    });

    ws.send(JSON.stringify({ type: 'connected', room: roomId }));
  });

  console.log('🔌 WebSocket სერვ. მზადაა: ws://...:/ws/chat');
  return wss;
}

// ── სხვა route-ებიდან (orders.js, reviews.js, disputes.js) გამოსაძახებელი დამხმარეები ──
// ჩატის ოთახში ავტ. სისტემური შეტყობინების (ან review-ის) რეალურ დროში გაგზავნა
function broadcastMessageToRoom(roomId, messageRow) {
  const conns = rooms.get(roomId);
  if (!conns || !conns.size) return;
  const payload = JSON.stringify({
    id:           messageRow.id,
    sender_id:    messageRow.sender_id,
    content:      messageRow.content,
    content_type: messageRow.content_type || 'text',
    created_at:   messageRow.created_at,
  });
  conns.forEach(c => { if (c.ws.readyState === 1) c.ws.send(payload); });
}

// listing/order სტატუსის ცვლილების რეალურ დროში გავრცელება (მაგ. 'sold' გაყიდვისას) —
// frontend-ი ამის მიხედვით მყისიერად შლის/ანახლებს განცხადებას გვ. გადატვირთვის გარეშე
function broadcastEventToRoom(roomId, event) {
  const conns = rooms.get(roomId);
  if (!conns || !conns.size) return;
  const payload = JSON.stringify({ type: 'order_status', ...event });
  conns.forEach(c => { if (c.ws.readyState === 1) c.ws.send(payload); });
}

// გლობალურ ჩატში ('global' pseudo-room) ახალი შეტყ.-ის ბრადქასთი —
// payload-ში სრული enriched ობიექტია (username/role/is_vip/avg_rating
// და მისთ.), განსხვავებით broadcastMessageToRoom-ის მოჭრილი ფორმისგან,
// რადგან frontend-ს widget-ში ბეჯების/რეიტინგის დასარენდერებლად სწორედ
// ეს დამატებითი ველები სჭირდება რეალურ დროშიც (არა მხოლოდ history GET-ზე).
function broadcastGlobalMessage(messageRow) {
  const conns = rooms.get('global');
  if (!conns || !conns.size) return;
  const payload = JSON.stringify({ type: 'global_message', message: messageRow });
  conns.forEach(c => { if (c.ws.readyState === 1) c.ws.send(payload); });
}

// ══════════════════════════════════════════════════════════════
// ადმინის სისტ. შეტყობინებები (listing removal/rejection და მისთ.) —
// გამოიყენება admin.js და listings.js-დან, როცა ადმინს/მოდერატორს
// სჭირდება გამყიდველთან შეტყობინების გაგზავნა ჩატში, თუმცა არ
// არსებობს order-ზე დაფუძნებული chat_room (chat_rooms.order_id
// NULL-ადია სქემაში სპეციალურად ამ შემთხვევისთვის).
//
// თითო გამყიდველთან ერთი მუდმივი "ადმინისტრაციის" ოთახი იქმნება
// (participant_a=გამყიდველი, participant_b=SUPER_ADMIN_EMAIL-ის
// მომხმარებელი) — ყველა შემდგომი admin-notice იმავე ოთახში ჩნდება.
//
// ⚠️ RACE-CONDITION FIX: წინა ვერსია SELECT-ს აკეთებდა, შემდეგ
// ცალკე INSERT-ს — ორ მოვლენას შორის ("check" და "create") window
// არსებობდა. თუ ერთსა და იმავე გამყიდველზე ორი ავტ. სისტ. შეტყობინება
// თითქმის ერთდროულად გაიშვებოდა (მაგ. listing reject + admin delete
// წამებში ერთმანეთის მიყოლებით, ან ორი პარალელური request), ორივეს
// SELECT არაფერს პოულობდა და ორივე თავის ოთახს ქმნიდა — სწორედ ეს
// წარმოქმნიდა sidebar-ში დუბლირებულ "Admin/Support" ოთახებს.
//
// გამოსწორება: მთელი "შემოწმება+შექმნა" ერთ ტრანზაქციაშია გახვეული და
// დაცულია Postgres advisory lock-ით (pg_advisory_xact_lock), რომელიც
// კონკრეტულ sellerId-ზეა keyed — ამიტომ ერთსა და იმავე
// მომხმარებელზე პარალელური მოთხოვნები ერთმანეთს ელოდებიან და მეორე
// ყოველთვის უკვე არსებულ ოთახს ხედავს, დუბლიკატს კი ვეღარ ქმნის.
// ══════════════════════════════════════════════════════════════
async function getOrCreateAdminRoom(sellerId) {
  return db.transaction(async (client) => {
    // ── Advisory lock ამ sellerId-ზე — ტრანზაქციის დასრულებამდე
    // ავტ. თავისუფლდება. ნებისმ. სხვა პარალელური მოთხოვნა იმავე
    // sellerId-სთვის აქ დაელოდება, სანამ პირველი არ დაასრულებს
    // ოთახის ძებნას/შექმნას — ეს გამორიცხავს check-then-insert race-ს. ──
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [sellerId]);

    const { rows: existing } = await client.query(
      `SELECT id, participant_a, participant_b FROM chat_rooms
       WHERE order_id IS NULL AND (participant_a=$1 OR participant_b=$1)
       LIMIT 1`,
      [sellerId]
    );
    if (existing.length) return existing[0];

    const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
    if (!superAdminEmail) throw new Error('SUPER_ADMIN_EMAIL_not_configured');

    const { rows: adminRows } = await client.query(
      'SELECT id FROM users WHERE LOWER(email)=$1', [superAdminEmail]
    );
    if (!adminRows.length) throw new Error('super_admin_user_not_found');
    const adminId = adminRows[0].id;

    const { rows: created } = await client.query(
      `INSERT INTO chat_rooms(order_id, participant_a, participant_b, status)
       VALUES (NULL, $1, $2, 'open')
       RETURNING id, participant_a, participant_b`,
      [sellerId, adminId]
    );
    return created[0];
  });
}

// გამყიდველისთვის ადმინისტრაციის სისტ. შეტყობინების გაგზავნა ჩატში —
// ავტ. პოულობს/ქმნის ოთახს (იხ. getOrCreateAdminRoom-ის race-safe
// ლოგიკა ზემოთ) და აგზავნის 'system' ტიპის მესიჯს (რეალურ დროშიც, თუ
// გამყიდველს ჩატი აქვს ღია — broadcastMessageToRoom-ის გავლით).
// ⚠️ ეს ფუნქცია ექსკლუზიურად სისტემურ/ადმინის ავტ. შეტყობინებებზეა
// განკუთვნილი (listing rejection/removal, warning-ები და მისთ.) —
// ჩვეულებრივი user-to-user ან order-ზე დაფუძნებული ჩატი (orders.js,
// disputes.js) ცალკე, order_id-ზე მიბმულ chat_room-ებს იყენებს და ამ
// ფუნქციას საერთოდ არ ეხება.
async function sendAdminNotice(sellerId, content) {
  const room = await getOrCreateAdminRoom(sellerId);
  const senderId = room.participant_a === sellerId ? room.participant_b : room.participant_a;

  const { rows: msgRows } = await db.query(`
    INSERT INTO messages(room_id, sender_id, content, content_type)
    VALUES ($1, $2, $3, 'system')
    RETURNING *
  `, [room.id, senderId, content]);

  broadcastMessageToRoom(room.id, msgRows[0]);
  return msgRows[0];
}

module.exports.setupWebSocket         = setupWebSocket;
module.exports.broadcastMessageToRoom = broadcastMessageToRoom;
module.exports.broadcastEventToRoom   = broadcastEventToRoom;
module.exports.broadcastGlobalMessage = broadcastGlobalMessage;
module.exports.getOrCreateAdminRoom   = getOrCreateAdminRoom;
module.exports.sendAdminNotice        = sendAdminNotice;
