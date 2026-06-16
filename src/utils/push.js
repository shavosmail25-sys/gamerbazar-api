// src/utils/push.js
// Web Push (VAPID) — ბრაუზერ. push შეტყობ. ლოგიკა
'use strict';

const webpush = require('web-push');
const db      = require('../db');

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return false; // push არ არის კონფიგ. — silent skip
  }
  webpush.setVapidDetails(
    VAPID_SUBJECT || 'mailto:admin@gamerbazar.ge',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  configured = true;
  return true;
}

// ── გამოწერა DB-ში შენახვა ────────────────────────────────────
async function saveSubscription(userId, subscription, userAgent) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('invalid_subscription');
  }
  await db.query(`
    INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, user_agent)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (endpoint) DO UPDATE SET
      user_id=$1, p256dh=$3, auth=$4, user_agent=$5
  `, [userId, endpoint, keys.p256dh, keys.auth, userAgent || null]);
}

// ── გამოწერის წაშლა ────────────────────────────────────────────
async function removeSubscription(endpoint) {
  await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
}

// ── ერთ მომხმარებელზე push გაგზავნა (ყველა მისი device) ───────
// payload: { title, body, url, icon, tag }
async function sendToUser(userId, payload) {
  if (!ensureConfigured()) return { sent: 0, configured: false };

  const { rows } = await db.query(
    'SELECT * FROM push_subscriptions WHERE user_id=$1', [userId]
  );
  if (!rows.length) return { sent: 0, configured: true };

  const body = JSON.stringify(payload);
  let sent = 0;

  await Promise.all(rows.map(async (sub) => {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, body);
      sent++;
    } catch (err) {
      // 404/410 — გამოწერა ვადაგასულია, წავშალოთ
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint).catch(() => {});
      } else {
        console.error('push send error:', err.message);
      }
    }
  }));

  return { sent, configured: true };
}

function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

module.exports = { saveSubscription, removeSubscription, sendToUser, getPublicKey, ensureConfigured };
