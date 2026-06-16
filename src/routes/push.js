// src/routes/push.js
// Web Push გამოწერების მართვა
'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const push    = require('../utils/push');
const router  = express.Router();

// GET /api/push/vapid-key  — public key frontend-ისთვის
router.get('/vapid-key', (req, res) => {
  const key = push.getPublicKey();
  if (!key) return res.status(503).json({ error: 'push_not_configured' });
  res.json({ publicKey: key });
});

// POST /api/push/subscribe
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'subscription_required' });

    await push.saveSubscription(req.user.id, subscription, req.headers['user-agent']);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.message === 'invalid_subscription')
      return res.status(400).json({ error: 'invalid_subscription' });
    console.error('push subscribe error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/push/unsubscribe
router.post('/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint_required' });
    await push.removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
