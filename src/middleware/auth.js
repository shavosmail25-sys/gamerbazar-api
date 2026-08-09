// src/routes/auth.js
// შესვლა/რეგისტრაცია — Email + OTP (პაროლების გარეშე), + Google OAuth
//
// ── Anti-Bot / Multi-Account / VPN-Proxy დაცვა ─────────────────
// ეს ფაილი "რეგისტრაციის კონტროლერია" ამ პროექტში — ცალკე
// POST /register არ არსებობს; ახალი ანგარიში გამჭვირვალედ იქმნება
// POST /verify-otp-ის შიგნით, პირველი წარმატებული კოდის
// გადამოწმებისას. ამიტომ ქვემოთ ყველა anti-fraud შემოწმება
// (captcha, IP-ლიმიტი, VPN/Proxy) კონცენტრირებულია სწორედ იქ, ახალი
// მომხმარებლის შექმნის განშტოებაში — არსებულ მომხმარებელს ჩვეულებრივ
// login-ზე (იგივე ენდფოინთი, უკვე არსებული email) ეს არ ეხება.
// იგივე დაცვა დამატებულია GET /google/callback-შიც, რომ Google OAuth
// არ იყოს ამ შემოწმებების უბრალო "გვერდის ავლის" გზა.
'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const security = require('../middleware/security');
const { getClientIp } = require('../utils/ip');

const mailer   = require('../utils/mailer');
const otp      = require('../utils/otp');
const referral = require('../utils/referral');
const router   = express.Router();

// ── სუპერ-ადმინის Email — ავტ. აღიჭურვება 'admin' როლით ────────
// უსაფრთხოების აუდიტის მოთხოვნით ჰარდქოდირებული fallback მისამართი
// მთლიანად ამოღებულია. SUPER_ADMIN_EMAIL სავალდებულოდ უნდა მოდიოდეს
// .env-დან — თუ ცვლადი არ არის განსაზღვრული, სერვერი საერთოდ ვერ ჩაეშვება
// (fail-closed), რომ არასდროს მოხდეს რომელიმე default/hardcoded მისამართზე
// admin წვდომის შემთხვევითი მინიჭება.
if (!process.env.SUPER_ADMIN_EMAIL) {
  throw new Error(
    '[auth.js] SUPER_ADMIN_EMAIL გარემოს ცვლადი არ არის დაყენებული. ' +
    'დააყენე .env ფაილში სუპერ-ადმინის ემაილი — hardcoded fallback განზრახ ამოღებულია.'
  );
}
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL.toLowerCase().trim();

// ── OTP_MAX_ATTEMPTS-ის per-code ლიმიტი (../utils/otp) ცალკე რჩება —
// ეს კონკრეტული OTP კოდის brute-force-ს იცავს (row-level, FOR UPDATE-ით
// ქვემოთ), IP-დონის რეით-ლიმიტი კი ახლა router-level middleware-ითაა
// (security.otpRequestLimiter / security.otpVerifyLimiter) — იხ. ქვემოთ.

// ── JWT ტოკენის გენერაცია ─────────────────────────────────────
function makeToken(userId) {
  return jwt.sign(
    { sub: userId, iat: Math.floor(Date.now() / 1000) },
    process.env.JWT_SECRET,
    // 30 დღიანი სესია — მომხმარებელი აღარ უნდა ვარდებოდეს სისტემიდან
    // ტაბის დახურვაზე ან ხანმოკლე უმოქმედობაზე. Override: JWT_EXPIRES_IN env-ით.
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
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

// ── SUPER_ADMIN_EMAIL-ს ყოველთვის 'admin' როლი ჰქონდეს ──────────
// გამოიძახება login/register-ის დროს (email ან google) — თუ მომხმარებელი
// ამ მისამართით შემოვიდა და role ჯერ 'admin' არაა, ავტ. აწერს და აბრუნებს
// განახლებულ user obj-ს, რომ token/response-ში სწორი role ჩანდეს დაუყოვნებლივ.
async function ensureAdminRole(user) {
  if (!user || !user.email) return user;
  if (user.email.toLowerCase().trim() !== SUPER_ADMIN_EMAIL) return user;
  if (user.role === 'admin') return user;

  const { rows } = await db.query(
    "UPDATE users SET role='admin' WHERE id=$1 RETURNING *",
    [user.id]
  );
  return rows[0] || user;
}

// ══════════════════════════════════════════════════════════════
// POST /api/auth/request-otp  — OTP კოდის გაგზავნა Email-ზე
// მუშაობს როგორც ახალი, ისე არსებული მომხმარებლისთვის (login == register)
//
// დაცვა: (1) express-rate-limit — IP-დან მაქს. N მოთხოვნა/15წთ
//        (2) Cloudflare Turnstile captcha — ბოტების მიერ მასობრივი
//            OTP-ემაილების spam-ის თავიდან ასაცილებლად (ეს ყველაზე
//            იაფი წერტილია ბოტისთვის — captcha სწორედ აქ ჩერდება, ჯერ
//            კიდევ მანამ, სანამ ერთი ემაილიც კი გაიგზავნება)
// ══════════════════════════════════════════════════════════════
router.post('/request-otp', security.otpRequestLimiter, async (req, res) => {
  try {
    const { email, captcha_token } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid_email', message: 'მიუთითე სწორი ელ-ფოსტა' });
    }
    const emailClean = email.toLowerCase().trim();
    const ip = getClientIp(req);

    // Anti-Bot: captcha ვერიფიკაცია
    const captchaOk = await security.verifyCaptcha(captcha_token, ip);
    if (!captchaOk) {
      return res.status(400).json({
        error: 'captcha_failed',
        message: 'ბოტ-დაცვის ვერიფიკაცია ვერ დადასტურდა — გთხოვთ, სცადოთ თავიდან.',
      });
    }

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
//
// დაცვა: (1) express-rate-limit — IP-დან მაქს. N მცდელობა/15წთ
//        (2) Cloudflare Turnstile captcha
//        (3) [მხოლოდ ᲐᲮᲐᲚᲘ ანგარიშისთვის] VPN/Proxy/TOR/Datacenter IP
//            დეტექცია (proxycheck.io)
//        (4) [მხოლოდ ᲐᲮᲐᲚᲘ ანგარიშისთვის] Max 2 ანგარიში/IP,
//            advisory-lock დაცული race condition-ისგან
// ══════════════════════════════════════════════════════════════
router.post('/verify-otp', security.otpVerifyLimiter, async (req, res) => {
  try {
    const { email, code, referral_code, captcha_token } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'required_fields', message: 'email და code სავალდებულოა' });
    }
    const emailClean = email.toLowerCase().trim();
    const codeClean   = String(code).trim();
    const ip = getClientIp(req);

    // Anti-Bot: captcha ვერიფიკაცია
    const captchaOk = await security.verifyCaptcha(captcha_token, ip);
    if (!captchaOk) {
      return res.status(400).json({
        error: 'captcha_failed',
        message: 'ბოტ-დაცვის ვერიფიკაცია ვერ დადასტურდა — გთხოვთ, სცადოთ თავიდან.',
      });
    }

    // ── რეფერალის ვალიდაცია — მოკლე, ადამიანისთვის წასაკითხი
    // `REF-XXXXXX` ფორმატი (ძველი UUID-ბმულის ნაცვლად, იხ.
    // src/utils/referral.js). ფორმატის შემოწმება მხოლოდ REGEX-ითაა
    // (ნორმალიზებული, ზედა რეგისტრში) — რეალურად არსებობს თუ არა
    // ასეთი კოდი, მხოლოდ ახალი user-ის შექმნის შემდეგ მოწმდება ქვემოთ
    // (referral.findUserByReferralCode). თუ ფორმატი არასწორია,
    // უბრალოდ იგნორირდება (null), რეგისტრაცია/login არასდროს ჩავარდება
    // რეფერალის ბრალით. ──
    const referralCodeClean = (typeof referral_code === 'string' && referral.REFERRAL_CODE_RE.test(referral_code.trim()))
      ? referral_code.trim().toUpperCase()
      : null;

    // ტრანზაქცია + row-level lock (FOR UPDATE) — პარალელურმა/ავტომატურმა
    // მოთხოვნებმა ვერ უნდა აუარონ გვერდი attempts-ლიმიტს race condition-ის
    // გამო (SELECT-ისა და attempts-ის UPDATE-ის ატომური თანმიმდევრობა).
    const verifyResult = await db.transaction(async (client) => {
      const { rows: otpRows } = await client.query(
        `SELECT * FROM otp_codes WHERE email=$1 AND used=FALSE
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [emailClean]
      );
      if (!otpRows.length) return { error: 'no_active_code' };
      const rec = otpRows[0];

      if (new Date(rec.expires_at) < new Date()) return { error: 'code_expired' };
      if (rec.attempts >= otp.OTP_MAX_ATTEMPTS) return { error: 'too_many_attempts' };

      if (otp.hashCode(codeClean) !== rec.code_hash) {
        await client.query('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1', [rec.id]);
        return { error: 'invalid_code' };
      }

      await client.query('UPDATE otp_codes SET used=TRUE WHERE id=$1', [rec.id]);
      return { ok: true };
    });

    if (verifyResult.error) {
      const statusByError = {
        no_active_code:    400,
        code_expired:      400,
        too_many_attempts: 429,
        invalid_code:      401,
      };
      const messageByError = {
        no_active_code:    'ჯერ გამოითხოვე OTP კოდი',
        code_expired:      'კოდს ვადა გაუვიდა — მოითხოვე ახალი',
        too_many_attempts: 'მცდელობების ლიმიტი ამოწურულია — მოითხოვე ახალი კოდი',
        invalid_code:      'არასწორი კოდი',
      };
      return res.status(statusByError[verifyResult.error]).json({
        error: verifyResult.error,
        message: messageByError[verifyResult.error],
      });
    }

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

      // ── ᲐᲮᲐᲚᲘ ᲐᲜᲒᲐᲠᲘᲨᲘᲡ ᲨᲔᲥᲛᲜᲐ — Anti-Fraud შემოწმებები ─────────────
      // (არსებულ მომხმარებელს login-ზე ეს არ ეხება — იხ. ზემოთ if
      // branch, სადაც user უკვე existing row-დანაა.)

      // 1) VPN / Proxy / TOR / Datacenter IP შემოწმება — შედარებით
      //    სწრაფი fail ვიდრე DB ტრანზაქცია, ამიტომ პირველია.
      const fraud = await security.checkIpFraud(ip);
      if (fraud.blocked) {
        security.logRegistrationAttempt({ email: emailClean, ip, result: 'vpn_blocked', meta: fraud });
        return res.status(403).json({
          error: 'vpn_proxy_blocked',
          message: 'რეგისტრაცია VPN/Proxy/TOR ქსელიდან შეზღუდულია. გთხოვთ, გამორთოთ VPN/Proxy და სცადოთ თავიდან.',
        });
      }

      const uname = await uniqueUsername(emailClean.split('@')[0]);

      // 2) Max 2 ანგარიში/IP + INSERT — ერთ ატომურ ტრანზაქციაში
      //    (advisory lock race condition-ის თავიდან ასაცილებლად, იხ.
      //    security.assertIpRegistrationAllowed კომენტარი).
      let created;
      try {
        created = await db.transaction(async (client) => {
          await security.assertIpRegistrationAllowed(client, ip);
          const { rows } = await client.query(`
            INSERT INTO users (email, username, display_name, auth_provider, email_verified, registration_ip)
            VALUES ($1,$2,$3,'email',TRUE,$4)
            RETURNING *
          `, [emailClean, uname, uname, ip]);
          return rows[0];
        });
      } catch (txErr) {
        if (txErr instanceof security.IpLimitError) {
          security.logRegistrationAttempt({ email: emailClean, ip, result: 'ip_limit' });
          return res.status(400).json({
            error: 'ip_limit_reached',
            message: 'Maximum account limit reached for this IP address.',
          });
        }
        throw txErr; // სხვა შეცდომები გარე catch-ში 500-ით მუშავდება
      }
      user = created;
      security.logRegistrationAttempt({ email: emailClean, ip, result: 'created' });

      // ── საკუთარი პრომო-კოდის გენერაცია — ყოველ ახალ ანგარიშს ჯერ
      // ვანიჭებთ თავის `REF-XXXXXX` კოდს (username-ის საფუძველზე), რომ
      // მან თავადაც შეძლოს სხვების მოწვევა. ──
      try {
        const newCode = await referral.ensureReferralCode(db, user.id, uname);
        if (newCode) user.referral_code = newCode;
      } catch (e) { console.error('referral code generation error:', e.message); }

      // ── რეფერალის მიბმა — მხოლოდ ᲐᲮᲐᲚᲘ ანგარიშისთვის, მხოლოდ ერთხელ.
      // referral_code frontend-დან მოდის — ან localStorage-ში შენახული
      // ?ref= URL პარამეტრიდან, ან რეგისტრაციის ფორმაში ხელით შეყვანილი
      // "რეფერალური/პრომო კოდი" (იხ. gamer-market-ge.html
      // captureReferralCode() და login მოდალის ახალი ველი). კოდით
      // რეფერერის მოძებნა (findUserByReferralCode) თავადვე ამოწმებს
      // ბანის სტატუსს; თვითრეფერალის თავიდან ასაცილებლად დამატებით
      // ვამოწმებთ, რომ ნაპოვნი რეფერერი არ ემთხვევა ახლადშექმნილი
      // ანგარიშის საკუთარ id-ს — წინააღმდეგ შემთხვევაში კოდი უბრალოდ
      // იგნორირდება (რეგისტრაცია ისედაც გრძელდება). ──
      if (referralCodeClean) {
        try {
          const referrerId = await referral.findUserByReferralCode(db, referralCodeClean);
          if (referrerId && referrerId !== user.id) {
            const { rows: updated } = await db.query(
              'UPDATE users SET referred_by=$1 WHERE id=$2 RETURNING *',
              [referrerId, user.id]
            );
            if (updated.length) user = updated[0];
          }
        } catch (e) { console.error('referral attach error:', e.message); }
      }
    }

    // ── Watch Tower წვდომა: SUPER_ADMIN_EMAIL-ს ავტ. ენიჭება 'admin' როლი ──
    user = await ensureAdminRole(user);

    const token = makeToken(user.id);
    res.json({
      token,
      is_new_user: isNewUser,
      user: {
        id: user.id, email: user.email, username: user.username,
        display_name: user.display_name, role: user.role,
        avatar_url: user.avatar_url, balance_gel: user.balance_gel,
        referral_code: user.referral_code || null,
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

  // ── რეფერალური კოდის გატარება Google OAuth-ის `state` პარამეტრში ──
  // Google callback-ს ზუსტად იმავე მნიშვნელობით გვიბრუნებს (echo), რაც
  // საშუალებას გვაძლევს Google-ით ახლად დარეგისტრირებულ მომხმარებელსაც
  // დავუფიქსიროთ referred_by. ფორმატის შემოწმება აქაც ხდება (ახლა
  // მოკლე `REF-XXXXXX` კოდის RE, ძველი UUID RE-ის ნაცვლად) —
  // არასწორი/ეჭვის შემტანი მნიშვნელობა უბრალოდ არ გადაეცემა Google-ს.
  const refRaw   = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
  const stateQS  = referral.REFERRAL_CODE_RE.test(refRaw)
    ? `&state=${encodeURIComponent(refRaw.toUpperCase())}`
    : '';

  const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${clientId}&redirect_uri=${callbackUrl}&response_type=code` +
    `&scope=${scope}&access_type=offline&prompt=select_account${stateQS}`;

  res.redirect(url);
});

// ══════════════════════════════════════════════════════════════
// GET /api/auth/google/callback  — Google-ის პასუხი
//
// ⚠️ Captcha აქ არ გამოიყენება — ეს redirect-based flow-ია (browser
// წინასწარ გადადის Google-ზე), frontend-ს captcha token-ის ხელით
// მიბმის შესაძლებლობა აქ არ აქვს. სამაგიეროდ VPN/Proxy და IP-ლიმიტ
// შემოწმებები აქაც მოქმედებს — წინააღმდეგ შემთხვევაში ბოტი უბრალოდ
// Google OAuth-ს გამოიყენებდა email/OTP დაცვების გვერდის ასავლელად.
// ══════════════════════════════════════════════════════════════
router.get('/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error || !code) {
      return res.redirect(`${process.env.FRONTEND_URL}?auth=error`);
    }
    const ip = getClientIp(req);

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
      // ── ᲐᲮᲐᲚᲘ ᲐᲜᲒᲐᲠᲘᲨᲘ (Google) — იგივე VPN/IP-limit დაცვა, რაც
      // email/OTP ნაკადს აქვს ზემოთ. ──
      const fraud = await security.checkIpFraud(ip);
      if (fraud.blocked) {
        security.logRegistrationAttempt({ email: profile.email, ip, result: 'vpn_blocked', meta: fraud });
        return res.redirect(`${process.env.FRONTEND_URL}?auth=vpn_blocked`);
      }

      const uname = await uniqueUsername(profile.name || profile.email.split('@')[0]);

      let created;
      try {
        created = await db.transaction(async (client) => {
          await security.assertIpRegistrationAllowed(client, ip);
          const { rows: inserted } = await client.query(`
            INSERT INTO users
              (email, username, display_name, avatar_url, gmail_id,
               auth_provider, email_verified, registration_ip)
            VALUES ($1,$2,$3,$4,$5,'google',TRUE,$6)
            RETURNING *
          `, [profile.email, uname, profile.name || uname, profile.picture, profile.id, ip]);
          return inserted[0];
        });
      } catch (txErr) {
        if (txErr instanceof security.IpLimitError) {
          security.logRegistrationAttempt({ email: profile.email, ip, result: 'ip_limit' });
          return res.redirect(`${process.env.FRONTEND_URL}?auth=ip_limit`);
        }
        throw txErr;
      }
      user = created;
      security.logRegistrationAttempt({ email: profile.email, ip, result: 'created' });

      // ── საკუთარი პრომო-კოდის გენერაცია — იგივე, რაც email/OTP
      // ნაკადში (იხ. POST /verify-otp ზემოთ). ──
      try {
        const newCode = await referral.ensureReferralCode(db, user.id, uname);
        if (newCode) user.referral_code = newCode;
      } catch (e) { console.error('referral code generation (google) error:', e.message); }

      // ── რეფერალის მიბმა — მხოლოდ ᲐᲮᲐᲚᲘ ანგარიშისთვის, `state`-ში
      // echo-ქმნილი კოდიდან (იხ. GET /google ზემოთ). იგივე წესები, რაც
      // email/OTP ნაკადში: `REF-XXXXXX` ფორმატის შემოწმება, თვითრეფერალის
      // აკრძალვა, რეფერერის არსებობის/არადაბლოკვის შემოწმება (ეს
      // ბოლო ორი findUserByReferralCode-ის შიგნით/შემდეგ ხდება). ──
      const refRaw = typeof req.query.state === 'string' ? req.query.state.trim() : '';
      if (referral.REFERRAL_CODE_RE.test(refRaw)) {
        try {
          const referrerId = await referral.findUserByReferralCode(db, refRaw);
          if (referrerId && referrerId !== user.id) {
            const { rows: updated } = await db.query(
              'UPDATE users SET referred_by=$1 WHERE id=$2 RETURNING *',
              [referrerId, user.id]
            );
            if (updated.length) user = updated[0];
          }
        } catch (e) { console.error('referral attach (google) error:', e.message); }
      }
    }

    if (user.role === 'banned') {
      return res.redirect(`${process.env.FRONTEND_URL}?auth=banned`);
    }

    // ── Watch Tower წვდომა: SUPER_ADMIN_EMAIL-ს ავტ. ენიჭება 'admin' როლი ──
    user = await ensureAdminRole(user);

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
             (u.is_vip AND u.vip_expires_at IS NOT NULL AND u.vip_expires_at > NOW()) AS is_vip,
             u.vip_expires_at, u.total_sales_gel,
             -- ── რეფერალური პროგრამა — პროფილის სტატისტიკისთვის ──
             u.referral_code, u.referral_earnings_gel,
             (SELECT COUNT(*) FROM users ru WHERE ru.referred_by = u.id) AS referral_invited_count,
             COALESCE(ss.completed_orders, 0) AS completed_orders,
             COALESCE(ss.avg_rating, 0)       AS avg_rating,
             COALESCE(ss.review_count, 0)     AS review_count
      FROM users u
      LEFT JOIN seller_stats ss ON ss.seller_id = u.id
      WHERE u.id=$1
    `, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    const me = rows[0];

    // ── Lazy backfill — ძველი ანგარიშები, migration-მდე შექმნილი,
    // ჯერ არ ფლობენ referral_code-ს. პირველივე /me ჩატვირთვაზე ვუწერთ
    // (ensureReferralCode idempotent-ია — თუ უკვე აქვს, უბრალოდ
    // დააბრუნებს არსებულს ხელახალი გენერაციის გარეშე). ──
    if (!me.referral_code) {
      try {
        const code = await referral.ensureReferralCode(db, me.id, me.username);
        if (code) me.referral_code = code;
      } catch (e) { console.error('referral code backfill error:', e.message); }
    }

    res.json(me);
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
