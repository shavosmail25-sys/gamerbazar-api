// src/routes/disputes.js
'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const router  = express.Router();

// POST /api/disputes  — დავის გახსნა
router.post('/', requireAuth, async (req, res) => {
  try {
    const { order_id, reason, description } = req.body;
    if (!order_id || !reason || !description)
      return res.status(400).json({ error: 'required_fields' });

    const { rows: o } = await db.query('SELECT * FROM orders WHERE id=$1', [order_id]);
    if (!o.length) return res.status(404).json({ error: 'order_not_found' });
    const order = o[0];

    if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)
      return res.status(403).json({ error: 'forbidden' });
    if (!['active','pending'].includes(order.status))
      return res.status(400).json({ error: 'cannot_dispute_this_order' });

    const { rows: ex } = await db.query(
      'SELECT id FROM disputes WHERE order_id=$1', [order_id]
    );
    if (ex.length) return res.status(409).json({ error: 'dispute_exists' });

    const { rows } = await db.query(`
      INSERT INTO disputes(order_id,opened_by,reason,description)
      VALUES($1,$2,$3,$4) RETURNING *
    `, [order_id, req.user.id, reason, description]);

    // order → disputed
    await db.query(
      "UPDATE orders SET status='disputed', escrow_status='disputed' WHERE id=$1",
      [order_id]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/disputes/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT d.*,
        o.buyer_id, o.seller_id, o.amount_gel,
        ob.username AS buyer_username,
        os.username AS seller_username
      FROM disputes d
      JOIN orders o ON o.id=d.order_id
      JOIN users ob ON ob.id=o.buyer_id
      JOIN users os ON os.id=o.seller_id
      WHERE d.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const d = rows[0];
    if (d.buyer_id !== req.user.id && d.seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });
    res.json(d);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// PUT /api/disputes/:id/resolve  — Admin-ის გადაწ.
router.put('/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { resolution, admin_note } = req.body;
    if (!['release','refund'].includes(resolution))
      return res.status(400).json({ error: 'resolution must be release or refund' });

    const { rows: d } = await db.query(
      'SELECT * FROM disputes WHERE id=$1', [req.params.id]
    );
    if (!d.length) return res.status(404).json({ error: 'not_found' });

    const { rows: o } = await db.query(
      'SELECT * FROM orders WHERE id=$1', [d[0].order_id]
    );
    const order = o[0];

    await db.transaction(async (client) => {
      if (resolution === 'release') {
        // გამყ-ს გადახდა
        await client.query(
          'UPDATE users SET balance_gel=balance_gel+$1 WHERE id=$2',
          [order.seller_receives, order.seller_id]
        );
        await client.query(
          'UPDATE users SET escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
          [order.amount_gel, order.buyer_id]
        );
        await client.query(
          "UPDATE orders SET escrow_status='released',status='completed',completed_at=NOW() WHERE id=$1",
          [order.id]
        );
      } else {
        // მყიდვ-ს დაბრ.
        await client.query(
          'UPDATE users SET balance_gel=balance_gel+$1, escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
          [order.amount_gel, order.buyer_id]
        );
        await client.query(
          "UPDATE orders SET escrow_status='refunded',status='cancelled',cancelled_at=NOW() WHERE id=$1",
          [order.id]
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
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
