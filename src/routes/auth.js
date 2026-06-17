// src/routes/auth.js
// რეგისტრაცია, შესვლა, Google OAuth

'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const crypto  = require('crypto');
const mailer  = require('../utils/mailer');
const router  = express.Router();

// ── Verification token გენ. ───────────────────────────────────
function makeVerifyToken() {
  return crypto.randomBytes(32).toString('hex');
}

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

    const emailClean    = email.toLowerCase().trim();
    const usernameClean = username.toLowerCase().trim();

    // email ცალკე შემოწმება
    const { rows: byEmail } = await db.query(
      'SELECT id FROM users WHERE email=$1', [emailClean]
    );
    if (byEmail.length) {
      return res.status(409).json({ error: 'email_exists', message: 'ეს email უკვე რეგისტრირებულია' });
    }

    // username ცალკე შემოწმება
    const { rows: byUser } = await db.query(
      'SELECT id FROM users WHERE username=$1', [usernameClean]
    );
    if (byUser.length) {
      return res.status(409).json({ error: 'username_exists', message: 'ეს username უკვე გამოყენებულია, სცადე სხვა' });
    }

    // პაროლის ჰეში
    const hash = await bcrypt.hash(password, 12);

    // შექმნა
    const { rows } = await db.query(
      `INSERT INTO users (email, username, display_name, password_hash, auth_provider, email_verified)
       VALUES ($1, $2, $3, $4, 'email', FALSE)
       RETURNING id, email, username, display_name, role, created_at`,
      [emailClean, usernameClean, display_name || username, hash]
    );

    const user  = rows[0];
    const token = makeToken(user.id);

    res.status(201).json({
      token, user,
      email_verification_sent: true,
      message: 'რეგისტრაცია წარმატებულია! შეამოწმე ემაილი დასადასტურებლად.'
    });

    // ვერიფიკაციის ემაილი — async
    (async () => {
      try {
        const verifyToken = makeVerifyToken();
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24სთ
        await db.query(
          'INSERT INTO email_verifications(user_id, token, expires_at) VALUES($1,$2,$3)',
          [user.id, verifyToken, expires]
        );
        await mailer.sendVerificationEmail(user, verifyToken);
      } catch(e) { console.error('verify email send error:', e.message); }
    })();
  } catch (err) {
    console.error('register error:', err.message);
    // PostgreSQL unique violation
    if (err.code === '23505') {
      const col = (err.constraint || '');
      if (col.includes('email'))    return res.status(409).json({ error: 'email_exists',    message: 'ეს email უკვე რეგისტრირებულია' });
      if (col.includes('username')) return res.status(409).json({ error: 'username_exists', message: 'ეს username უკვე გამოყენებულია' });
      return res.status(409).json({ error: 'already_exists', message: 'ეს email ან username უკვე გამოყენებულია' });
    }
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/auth/verify-email?token=xxx
// ══════════════════════════════════════════════════════════════
router.get('/verify-email', async (req, res) => {
  const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:3000';
  try {
    const { token } = req.query;
    if (!token) return res.redirect(`${FRONTEND}/?verify=invalid`);

    const { rows } = await db.query(
      'SELECT * FROM email_verifications WHERE token=$1 AND expires_at > NOW() AND used=FALSE',
      [token]
    );
    if (!rows.length) return res.redirect(`${FRONTEND}/?verify=expired`);

    const v = rows[0];
    await db.query('UPDATE users SET email_verified=TRUE WHERE id=$1', [v.user_id]);
    await db.query('UPDATE email_verifications SET used=TRUE WHERE id=$1', [v.id]);

    res.redirect(`${FRONTEND}/?verify=success`);
  } catch(err) {
    console.error('verify email error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL || ''}/?verify=error`);
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/auth/resend-verification  — ხელახლა გაგზავნა
// ══════════════════════════════════════════════════════════════
router.post('/resend-verification', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const user = rows[0];
    if (user.email_verified) return res.status(400).json({ error: 'already_verified' });

    // წინა token-ები გავაუქმოთ
    await db.query('UPDATE email_verifications SET used=TRUE WHERE user_id=$1', [user.id]);

    const verifyToken = makeVerifyToken();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.query(
      'INSERT INTO email_verifications(user_id, token, expires_at) VALUES($1,$2,$3)',
      [user.id, verifyToken, expires]
    );
    await mailer.sendVerificationEmail(user, verifyToken);

    res.json({ ok: true, message: 'ვერიფიკაციის ემაილი გაიგზავნა' });
  } catch(err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/auth/forgot-password  — პაროლის გადაყენება
// ══════════════════════════════════════════════════════════════
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email_required' });

    const { rows } = await db.query(
      "SELECT * FROM users WHERE email=$1 AND auth_provider='email'",
      [email.toLowerCase()]
    );

    // security: ყოველთვის ok ვუბრუნებთ (email enumeration-ის თავიდან ასაცილებლად)
    res.json({ ok: true, message: 'თუ ეს ემაილი რეგისტრირებულია, მიიღებ ლინკს' });

    if (!rows.length) return;
    const user = rows[0];

    (async () => {
      try {
        const resetToken = makeVerifyToken();
        const expires = new Date(Date.now() + 60 * 60 * 1000); // 1სთ
        await db.query(
          'INSERT INTO password_resets(user_id, token, expires_at) VALUES($1,$2,$3)',
          [user.id, resetToken, expires]
        );
        await mailer.sendPasswordResetEmail(user, resetToken);
      } catch(e) { console.error('forgot password error:', e.message); }
    })();
  } catch(err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/auth/reset-password  — ახალი პაროლის დაყენება
// ══════════════════════════════════════════════════════════════
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'required_fields' });
    if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });

    const { rows } = await db.query(
      'SELECT * FROM password_resets WHERE token=$1 AND expires_at > NOW() AND used=FALSE',
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: 'invalid_or_expired_token' });

    const hash = await bcrypt.hash(password, 12);
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rows[0].user_id]);
    await db.query('UPDATE password_resets SET used=TRUE WHERE id=$1', [rows[0].id]);

    res.json({ ok: true, message: 'პაროლი წარმატებით შეიცვალა' });
  } catch(err) {
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
