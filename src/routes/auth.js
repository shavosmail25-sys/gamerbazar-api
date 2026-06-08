// src/routes/auth.js
// რეგისტრაცია, შესვლა, Google OAuth

'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── JWT ტოკენის გენერაცია ─────────────────────────────────────
function makeToken(userId) {
  return jwt.sign(
    { sub: userId, iat: Math.floor(Date.now() / 1000) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ── Username-ის ავტომ. გენ. ──────────────────────────────────
async function uniqueUsername(base) {
  const slug = base.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'user';
  let name = slug, i = 2;
  while (true) {
    const { rows } = await db.query('SELECT id FROM users WHERE username=$1', [name]);
    if (!rows.length) return name;
    name = `${slug}${i++}`;
  }
}

// ══════════════════════════════════════════════════════════════
// POST /api/auth/register  — ელ-ფოსტით რეგისტრაცია
// ══════════════════════════════════════════════════════════════
router.post('/register', async (req, res) => {
  try {
    const { email, password, username, display_name } = req.body;

    // ვალიდაცია
    if (!email || !password || !username) {
      return res.status(400).json({ error: 'required_fields', message: 'email, password, username სავალდებულოა' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'password_too_short', message: 'პაროლი მინ. 6 სიმბ.' });
    }
    if (!/^[a-z0-9_]{3,30}$/i.test(username)) {
      return res.status(400).json({ error: 'invalid_username', message: 'username: 3-30 ლათ. სიმბ.' });
    }

    // დუბლიკატის შემოწ.
    const { rows: ex } = await db.query(
      'SELECT id FROM users WHERE email=$1 OR username=$2',
      [email.toLowerCase(), username.toLowerCase()]
    );
    if (ex.length) {
      return res.status(409).json({ error: 'already_exists', message: 'ეს email ან username უკვე გამოყენებულია' });
    }

    // პაროლის ჰეში
    const hash = await bcrypt.hash(password, 12);

    // შექმნა
    const { rows } = await db.query(`
      INSERT INTO users (email, username, display_name, password_hash, auth_provider, email_verified)
      VALUES ($1, $2, $3, $4, 'email', FALSE)
      RETURNING id, email, username, display_name, role, created_at
    `, [email.toLowerCase(), username.toLowerCase(), display_name || username, hash]);

    const user  = rows[0];
    const token = makeToken(user.id);

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('register error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/auth/login  — ელ-ფოსტა + პაროლი
// ══════════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'required_fields' });
    }

    const { rows } = await db.query(
      'SELECT * FROM users WHERE email=$1',
      [email.toLowerCase()]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'არასწორი email ან პაროლი' });
    }

    const user = rows[0];
    if (user.role === 'banned') {
      return res.status(403).json({ error: 'banned', message: 'ეს ექ. დაბლოკილია' });
    }
    if (!user.password_hash) {
      return res.status(401).json({ error: 'use_google', message: 'Google-ით შედი' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'არასწორი email ან პაროლი' });
    }

    // last_seen განახლება
    await db.query('UPDATE users SET last_seen_at=NOW() WHERE id=$1', [user.id]);

    const token = makeToken(user.id);
    res.json({
      token,
      user: {
        id: user.id, email: user.email, username: user.username,
        display_name: user.display_name, role: user.role,
        avatar_url: user.avatar_url, balance_gel: user.balance_gel,
      }
    });
  } catch (err) {
    console.error('login error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/auth/google  — Google OAuth redirect
// ══════════════════════════════════════════════════════════════
router.get('/google', (req, res) => {
  const clientId    = process.env.GOOGLE_CLIENT_ID;
  const callbackUrl = encodeURIComponent(process.env.GOOGLE_CALLBACK_URL);
  const scope       = encodeURIComponent('openid email profile');

  if (!clientId || clientId.includes('XXXXX')) {
    return res.status(503).json({
      error: 'oauth_not_configured',
      message: '.env-ში GOOGLE_CLIENT_ID შეავსე'
    });
  }

  const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${clientId}&redirect_uri=${callbackUrl}&response_type=code` +
    `&scope=${scope}&access_type=offline&prompt=select_account`;

  res.redirect(url);
});

// ══════════════════════════════════════════════════════════════
// GET /api/auth/google/callback  — Google-ის პასუხი
// ══════════════════════════════════════════════════════════════
router.get('/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error || !code) {
      return res.redirect(`${process.env.FRONTEND_URL}?auth=error`);
    }

    // 1. Code → Access Token (Google-ს ვთხოვთ)
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  process.env.GOOGLE_CALLBACK_URL,
        grant_type:    'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error('Google token failed: ' + JSON.stringify(tokenData));
    }

    // 2. Access Token → User Info
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    // profile = { id, email, name, picture, ... }

    // 3. DB-ში მოძებნე ან შექმენი
    let { rows } = await db.query(
      'SELECT * FROM users WHERE gmail_id=$1 OR email=$2',
      [profile.id, profile.email]
    );

    let user;
    if (rows.length) {
      user = rows[0];
      // Gmail ID-ის განახლება (თუ email-ით დარეგ.)
      if (!user.gmail_id) {
        await db.query(
          'UPDATE users SET gmail_id=$1, avatar_url=$2, email_verified=TRUE WHERE id=$3',
          [profile.id, profile.picture, user.id]
        );
      }
      await db.query('UPDATE users SET last_seen_at=NOW() WHERE id=$1', [user.id]);
    } else {
      // ახალი მომხმარებელი
      const uname = await uniqueUsername(profile.name || profile.email.split('@')[0]);
      const { rows: created } = await db.query(`
        INSERT INTO users
          (email, username, display_name, avatar_url, gmail_id,
           auth_provider, email_verified)
        VALUES ($1,$2,$3,$4,$5,'google',TRUE)
        RETURNING *
      `, [profile.email, uname, profile.name || uname, profile.picture, profile.id]);
      user = created[0];
    }

    if (user.role === 'banned') {
      return res.redirect(`${process.env.FRONTEND_URL}?auth=banned`);
    }

    const token = makeToken(user.id);
    // Frontend-ზე redirect token-ით
    res.redirect(`${process.env.FRONTEND_URL}?auth=success&token=${token}`);

  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}?auth=error`);
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/auth/me  — მიმდ. მომხ. ინფო
// ══════════════════════════════════════════════════════════════
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, email, username, display_name, bio, avatar_url,
             role, is_verified_seller, discord_handle, steam_id,
             balance_gel, balance_usd, escrow_hold_gel,
             notif_email, notif_push, notif_chat,
             profile_public, show_online,
             email_verified, created_at, last_seen_at
      FROM users WHERE id=$1
    `, [req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/auth/me  — პროფილის განახლება
// ══════════════════════════════════════════════════════════════
router.put('/me', requireAuth, async (req, res) => {
  try {
    const {
      display_name, bio, discord_handle, steam_id,
      notif_email, notif_push, notif_chat,
      profile_public, show_online
    } = req.body;

    const { rows } = await db.query(`
      UPDATE users SET
        display_name  = COALESCE($1, display_name),
        bio           = COALESCE($2, bio),
        discord_handle= COALESCE($3, discord_handle),
        steam_id      = COALESCE($4, steam_id),
        notif_email   = COALESCE($5, notif_email),
        notif_push    = COALESCE($6, notif_push),
        notif_chat    = COALESCE($7, notif_chat),
        profile_public= COALESCE($8, profile_public),
        show_online   = COALESCE($9, show_online),
        updated_at    = NOW()
      WHERE id=$10
      RETURNING id, email, username, display_name, bio, avatar_url,
                discord_handle, steam_id, role
    `, [display_name, bio, discord_handle, steam_id,
        notif_email, notif_push, notif_chat,
        profile_public, show_online, req.user.id]);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
