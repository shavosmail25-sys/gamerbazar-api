// src/middleware/auth.js
// JWT ტოკენის შემოწმება ყველა დაცულ route-ზე

'use strict';

const jwt = require('jsonwebtoken');
const db  = require('../db');

// ── სავალდებულო auth ──────────────────────────────────────────
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'token_missing', message: 'ავტ. საჭიროა' });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // მომხ. ბაზაში არსებობს?
    const { rows } = await db.query(
      'SELECT id, email, username, display_name, role, avatar_url FROM users WHERE id = $1',
      [payload.sub]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'user_not_found' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'token_expired' });
    }
    return res.status(401).json({ error: 'token_invalid' });
  }
}

// ── სურვილისამებრ auth (კი თუ გასულია) ────────────────────────
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { req.user = null; return next(); }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await db.query(
      'SELECT id, email, username, display_name, role, avatar_url FROM users WHERE id = $1',
      [payload.sub]
    );
    req.user = rows[0] || null;
  } catch {
    req.user = null;
  }
  next();
}

// ── Admin-ის შემოწმება ────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin_only' });
  }
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin };
