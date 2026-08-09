// src/middleware/security.js
// Anti-Bot + Multi-Account Prevention + VPN/Proxy Detection
// გამოიყენება src/routes/auth.js-ში (POST /request-otp და POST /verify-otp).
'use strict';

const rateLimit = require('express-rate-limit');
const db = require('../db');
const { getClientIp, isPrivateIp } = require('../utils/ip');

// ══════════════════════════════════════════════════════════════
// 1) EXPRESS-RATE-LIMIT — ბოტ/brute-force დაცვა
//
// ⚠️ საჭიროებს app.set('trust proxy', 1)-ს მთავარ app ფაილში
// (Railway-ის ერთი reverse-proxy hop-ისთვის ზუსტად სწორი მნიშვნელობაა
// `1`, არა `true` — `true` ძალიან "პერმისიულია" და express-rate-limit
// საერთოდ არ გაეშვება, ისროლის ValidationError-ს).
//
// ⚠️ Horizontal scaling: default MemoryStore თითო Railway replica-ს
// ცალკე ითვლის. თუ რამდენიმე instance გაქვთ გაშვებული ერთდროულად,
// გამოიყენეთ `rate-limit-redis` საზიარო store-ად (npm install
// rate-limit-redis ioredis), წინააღმდეგ შემთხვევაში ლიმიტი
// ეფექტურად N-ჯერ იზრდება (N = replica-ების რაოდენობა).
// ══════════════════════════════════════════════════════════════

const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 წუთი
  max: Number(process.env.RATE_LIMIT_OTP_REQUEST_MAX || 10), // მაქს. 10 OTP მოთხოვნა/IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res) => {
    res.status(429).json({
      error: 'too_many_requests',
      message: 'ძალიან ბევრი მოთხოვნა ამ მისამართიდან — სცადე მოგვიანებით',
    });
  },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 წუთი
  max: Number(process.env.RATE_LIMIT_OTP_VERIFY_MAX || 20), // მაქს. 20 verify მცდელობა/IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res) => {
    res.status(429).json({
      error: 'too_many_requests',
      message: 'ძალიან ბევრი მცდელობა ამ მისამართიდან — სცადე მოგვიანებით',
    });
  },
});

// ══════════════════════════════════════════════════════════════
// 2) CLOUDFLARE TURNSTILE — captcha token ვერიფიკაცია
//
// (reCAPTCHA v3-ზე გადასართველად: POST-ავდი
// https://www.google.com/recaptcha/api/siteverify-ზე იმავე
// {secret, response} ფორმატით და ამოწმებდი `data.success && data.score
// >= 0.5`-ს ნაცვლად `data.success`-ისა. Turnstile არჩეულია, რადგან
// უფასოა შეუზღუდავი მოთხოვნებით და score-threshold tuning არ სჭირდება.)
// ══════════════════════════════════════════════════════════════
async function verifyCaptcha(token, remoteip) {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    // ⚠️ FAIL-OPEN მხოლოდ მაშინ, როცა გასაღები საერთოდ არ არის
    // კონფიგურირებული (ჩვეულებრივ — ლოკალური dev გარემო). PRODUCTION-ში
    // აუცილებლად დააყენეთ TURNSTILE_SECRET_KEY — წინააღმდეგ შემთხვევაში
    // ეს დაცვა ჩუმად გამოტოვებულია ყოველგვარი შეცდომის გარეშე.
    console.warn('[security] TURNSTILE_SECRET_KEY არ არის დაყენებული — captcha ვერიფიკაცია გამოტოვებულია');
    return true;
  }
  if (!token || typeof token !== 'string') return false;

  try {
    const params = new URLSearchParams();
    params.append('secret', process.env.TURNSTILE_SECRET_KEY);
    params.append('response', token);
    if (remoteip && !isPrivateIp(remoteip)) params.append('remoteip', remoteip);

    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    return data.success === true;
  } catch (e) {
    console.error('[security] Turnstile verify error:', e.message);
    return false; // ქსელის/API-ის შეცდომაზე FAIL-CLOSED — captcha-ს არ ვენდობით
  }
}

// ══════════════════════════════════════════════════════════════
// 3) PROXYCHECK.IO — VPN / Proxy / TOR / Datacenter IP დეტექცია
// უფასო tier: https://proxycheck.io/api/ (გასაღების გარეშეც მუშაობს,
// დღიური ლიმიტით — უფასო რეგისტრაციით ლიმიტი იზრდება).
// ══════════════════════════════════════════════════════════════
async function checkIpFraud(ip) {
  if (isPrivateIp(ip)) return { blocked: false, reason: 'private_ip_skipped' };

  try {
    const keyParam = process.env.PROXYCHECK_API_KEY ? `key=${process.env.PROXYCHECK_API_KEY}&` : '';
    const url = `https://proxycheck.io/v2/${encodeURIComponent(ip)}?${keyParam}vpn=1&asn=1&risk=1`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const data = await resp.json();

    if (data.status !== 'ok' && data.status !== 'warning') {
      // API-ის საკუთარი შეცდომა (მაგ. rate-limit ამოწურული) — FAIL-OPEN,
      // რომ ლეგიტიმურ მომხმარებელს რეგისტრაცია არ დავუბლოკოთ 3rd-party
      // სერვისის დროებითი მიუწვდომლობის გამო.
      return { blocked: false, reason: 'api_error' };
    }

    const info = data[ip];
    if (!info) return { blocked: false, reason: 'no_data' };

    const flaggedProxy = info.proxy === 'yes';
    const flaggedType  = ['VPN', 'TOR', 'Hosting/Data Center'].includes(info.type);
    const highRisk      = Number(info.risk || 0) >= 90;

    if (flaggedProxy || flaggedType || highRisk) {
      return { blocked: true, reason: info.type || 'proxy', risk: info.risk };
    }
    return { blocked: false };
  } catch (e) {
    console.error('[security] proxycheck.io error:', e.message);
    return { blocked: false, reason: 'api_exception' }; // FAIL-OPEN ქსელის შეცდომაზე
  }
}

// ══════════════════════════════════════════════════════════════
// 4) STRICT IP LIMIT — მაქს. N ანგარიში ერთ IP-ზე
//
// გამოიძახება db.transaction(client => ...)-ის შიგნით, ახალი
// მომხმარებლის INSERT-მდე. pg_advisory_xact_lock ტრანზაქციის
// ფარგლებში კეტავს ამ კონკრეტულ IP-ს (ჰეშირებული bigint-ად) — ასე
// ორი პარალელური რეგისტრაცია იმავე IP-დან ვერ "გაასწრებს" ერთმანეთს
// COUNT(*) შემოწმებასა და INSERT-ს შორის (race condition-ის თავიდან
// აცილება). ლოკი ავტ. თავისუფლდება commit/rollback-ზე.
// ══════════════════════════════════════════════════════════════
class IpLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IpLimitError';
  }
}

const MAX_ACCOUNTS_PER_IP = Number(process.env.MAX_ACCOUNTS_PER_IP || 2);

async function assertIpRegistrationAllowed(client, ip) {
  if (isPrivateIp(ip)) return; // ლოკალური dev გარემო — გამოტოვება

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ip]);

  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS n FROM users WHERE registration_ip = $1',
    [ip]
  );
  if (rows[0].n >= MAX_ACCOUNTS_PER_IP) {
    throw new IpLimitError('Maximum account limit reached for this IP address.');
  }
}

// ── აუდიტის ჟურნალი (registration_attempts) — non-blocking, "fire and
// forget" (შიდა try/catch-ით), რომ log-ის ჩავარდნამ არასდროს შეაფერხოს
// რეალური registration flow. ──
async function logRegistrationAttempt({ email, ip, result, meta }) {
  try {
    await db.query(
      `INSERT INTO registration_attempts (email, ip, result, meta) VALUES ($1,$2,$3,$4)`,
      [email || null, ip, result, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) {
    console.error('[security] registration_attempts log error:', e.message);
  }
}

module.exports = {
  otpRequestLimiter,
  otpVerifyLimiter,
  verifyCaptcha,
  checkIpFraud,
  assertIpRegistrationAllowed,
  logRegistrationAttempt,
  IpLimitError,
  MAX_ACCOUNTS_PER_IP,
};
