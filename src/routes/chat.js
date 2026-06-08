// src/routes/chat.js
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// ══════════════════════════════════════════════════════════════
// GET /api/chat/rooms  — ჩემი ოთახები
// ══════════════════════════════════════════════════════════════
router.get('/rooms', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        r.*,
        o.status        AS order_status,
        o.amount_gel,
        o.escrow_status,
        l.title         AS listing_title,
        l.game,
        ua.username     AS participant_a_name,
        ua.avatar_url   AS participant_a_avatar,
        ub.username     AS participant_b_name,
        ub.avatar_url   AS participant_b_avatar,
        (SELECT content FROM messages m
         WHERE m.room_id=r.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m
         WHERE m.room_id=r.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
        (SELECT COUNT(*) FROM messages m
         WHERE m.room_id=r.id AND m.sender_id!=$1 AND m.is_read=FALSE) AS unread_count
      FROM chat_rooms r
      JOIN orders o   ON o.id=r.order_id
      JOIN listings l ON l.id=o.listing_id
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

    res.status(201).json(rows[0]);
  } catch (err) {
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

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/chat' });

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

    // ოთახში წვდომის შემოწ.
    try {
      const { rows } = await db.query(
        'SELECT id FROM chat_rooms WHERE id=$1 AND (participant_a=$2 OR participant_b=$2)',
        [roomId, userId]
      );
      if (!rows.length) { ws.close(4003, 'forbidden'); return; }
    } catch { ws.close(4000, 'error'); return; }

    // ოთახში დამ.
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const conn = { ws, userId };
    rooms.get(roomId).add(conn);

    ws.on('message', async (raw) => {
      try {
        const { content } = JSON.parse(raw.toString());
        if (!content?.trim()) return;

        // DB-ში შენ.
        const { rows } = await db.query(
          'INSERT INTO messages(room_id,sender_id,content) VALUES($1,$2,$3) RETURNING *',
          [roomId, userId, content.trim()]
        );
        const msg = rows[0];

        // ყველა ოთახის წევრს გაგ.
        const payload = JSON.stringify({
          id:         msg.id,
          sender_id:  userId,
          content:    msg.content,
          created_at: msg.created_at,
        });
        rooms.get(roomId)?.forEach(c => {
          if (c.ws.readyState === 1) c.ws.send(payload);
        });
      } catch (err) {
        console.error('ws message error:', err.message);
      }
    });

    ws.on('close', () => {
      rooms.get(roomId)?.delete(conn);
      if (rooms.get(roomId)?.size === 0) rooms.delete(roomId);
    });

    ws.send(JSON.stringify({ type: 'connected', room: roomId }));
  });

  console.log('🔌 WebSocket სერვ. მზადაა: ws://...:/ws/chat');
  return wss;
}

module.exports.setupWebSocket = setupWebSocket;
