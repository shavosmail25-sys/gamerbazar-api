// src/routes/auth.js
// შესვლა/რეგისტრაცია — Email + OTP (პაროლების გარეშე), + Google OAuth

'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const mailer  = require('../utils/mailer');
const otp     = require('../utils/otp');
const router  = express.Router();

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
// POST /api/auth/request-otp  — OTP კოდის გაგზავნა Email-ზე
// მუშაობს როგორც ახალი, ისე არსებული მომხმარებლისთვის (login == register)
// ══════════════════════════════════════════════════════════════
router.post('/request-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid_email', message: 'მიუთითე სწორი ელ-ფოსტა' });
    }
    const emailClean = email.toLowerCase().trim();

    // დაბ. ანგარიშს OTP აღარ ეგზავნება
    const { rows: banned } = await db.query(
      "SELECT id FROM users WHERE email=$1 AND role='banned'", [emailClean]
    );
    if (banned.length) {
      return res.status(403).json({ error: 'banned', message: 'ეს ანგარიში დაბლოკილია' });
    }

    // Resend cooldown — ბოლო კოდი ბოლო 60 წმ-ში თუ გაგზავნილა, ახალს არ ვგზავნით
    const { rows: recent } = await db.query(
      `SELECT created_at FROM otp_codes WHERE email=$1 AND used=FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [emailClean]
    );
    if (recent.length) {
      const secsSince = (Date.now() - new Date(recent[0].created_at).getTime()) / 1000;
      if (secsSince < otp.OTP_RESEND_COOLDOWN_SECONDS) {
        return res.status(429).json({
          error: 'too_soon',
          message: `გთხოვ დაელოდე ${Math.ceil(otp.OTP_RESEND_COOLDOWN_SECONDS - secsSince)} წამს`,
          retry_after_seconds: Math.ceil(otp.OTP_RESEND_COOLDOWN_SECONDS - secsSince),
        });
      }
    }

    const code       = otp.generateCode();
    const codeHash   = otp.hashCode(code);
    const expiresAt  = new Date(Date.now() + otp.OTP_TTL_MINUTES * 60 * 1000);

    // წინა გამოუყენ. კოდები ამ ემაილზე — გავაუქმოთ
    await db.query("UPDATE otp_codes SET used=TRUE WHERE email=$1 AND used=FALSE", [emailClean]);
    await db.query(
      `INSERT INTO otp_codes(email, code_hash, purpose, expires_at) VALUES ($1,$2,'login',$3)`,
      [emailClean, codeHash, expiresAt]
    );

    res.json({
      ok: true,
      message: 'OTP კოდი გაიგზავნა ელ-ფოსტაზე',
      expires_in_seconds: otp.OTP_TTL_MINUTES * 60,
    });

    // ემაილის გაგზავნა — async
    (async () => {
      try {
        await mailer.sendOtpEmail(emailClean, code, otp.OTP_TTL_MINUTES);
      } catch (e) { console.error('otp email send error:', e.message); }
    })();
  } catch (err) {
    console.error('request-otp error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/auth/verify-otp  — კოდის დადასტურება → login ან auto-register
// ══════════════════════════════════════════════════════════════
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'required_fields', message: 'email და code სავალდებულოა' });
    }
    const emailClean = email.toLowerCase().trim();
    const codeClean   = String(code).trim();

    const { rows: otpRows } = await db.query(
      `SELECT * FROM otp_codes WHERE email=$1 AND used=FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [emailClean]
    );
    if (!otpRows.length) {
      return res.status(400).json({ error: 'no_active_code', message: 'ჯერ გამოითხოვე OTP კოდი' });
    }
    const rec = otpRows[0];

    if (new Date(rec.expires_at) < new Date()) {
      return res.status(400).json({ error: 'code_expired', message: 'კოდს ვადა გაუვიდა — მოითხოვე ახალი' });
    }
    if (rec.attempts >= otp.OTP_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'too_many_attempts', message: 'მცდელობების ლიმიტი ამოწურულია — მოითხოვე ახალი კოდი' });
    }

    if (otp.hashCode(codeClean) !== rec.code_hash) {
      await db.query('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1', [rec.id]);
      return res.status(401).json({ error: 'invalid_code', message: 'არასწორი კოდი' });
    }

    // კოდი გამოყენებულია
    await db.query('UPDATE otp_codes SET used=TRUE WHERE id=$1', [rec.id]);

    // მომხმარებელი — მოძებნა ან ავტ. შექმნა
    let { rows: users } = await db.query('SELECT * FROM users WHERE email=$1', [emailClean]);
    let user;
    let isNewUser = false;

    if (users.length) {
      user = users[0];
      if (user.role === 'banned') {
        return res.status(403).json({ error: 'banned', message: 'ეს ანგარიში დაბლოკილია' });
      }
      await db.query(
        'UPDATE users SET email_verified=TRUE, last_seen_at=NOW() WHERE id=$1',
        [user.id]
      );
    } else {
      isNewUser = true;
      const uname = await uniqueUsername(emailClean.split('@')[0]);
      const { rows: created } = await db.query(`
        INSERT INTO users (email, username, display_name, auth_provider, email_verified)
        VALUES ($1,$2,$3,'email',TRUE)
        RETURNING *
      `, [emailClean, uname, uname]);
      user = created[0];
    }

    const token = makeToken(user.id);
    res.json({
      token,
      is_new_user: isNewUser,
      user: {
        id: user.id, email: user.email, username: user.username,
        display_name: user.display_name, role: user.role,
        avatar_url: user.avatar_url, balance_gel: user.balance_gel,
      },
    });
  } catch (err) {
    console.error('verify-otp error:', err.message);
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
      SELECT u.id, u.email, u.username, u.display_name, u.bio, u.avatar_url,
             u.role, u.is_verified_seller, u.discord_handle, u.steam_id,
             u.balance_gel, u.balance_usd, u.escrow_hold_gel,
             u.notif_email, u.notif_push, u.notif_chat,
             u.profile_public, u.show_online,
             u.email_verified, u.created_at, u.last_seen_at,
             COALESCE(ss.completed_orders, 0) AS completed_orders,
             COALESCE(ss.avg_rating, 0)       AS avg_rating,
             COALESCE(ss.review_count, 0)     AS review_count
      FROM users u
      LEFT JOIN seller_stats ss ON ss.seller_id = u.id
      WHERE u.id=$1
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
