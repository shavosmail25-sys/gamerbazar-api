// src/routes/wallet.js
'use strict';

const express    = require('express');
const multer     = require('multer');
const db         = require('../db');
const { requireAuth } = require('../middleware/auth');
const mailer     = require('../utils/mailer');
const ledger     = require('../utils/ledger');
const referral   = require('../utils/referral');
const cloudinary = require('../utils/cloudinary');

const ADMIN_EMAIL = process.env.EMAIL_USER || process.env.SMTP_USER || 'shavosmail25@gmail.com';
const router  = express.Router();

// ── Deposit Screenshot Upload — multer memoryStorage, Cloudinary-ში
// ასატვირთად (იგივე პატერნი, რაც disputes.js-ში evidence ფაილებზე) ──
const depositUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|webp|gif)/.test(file.mimetype);
    cb(ok ? null : new Error('only_images'), ok);
  },
});

// ── გამოტანის ლიმიტები — abuse-ის თავიდან ასაცილებლად ──────────────
// Amount: მინ. ₾20 / მაქს. ₾200 თითო მოთხოვნაზე.
// Frequency: მაქს. 1 მოთხოვნა 24 საათში (frontend-ის იგივე ლიმიტი
// gamer-market-ge.html-ში, doWithdraw()-ში, უნდა ემთხვეოდეს ამას).
const WITHDRAW_MIN_GEL          = 20;
const WITHDRAW_MAX_GEL          = 200;
const WITHDRAW_COOLDOWN_HOURS   = 24;

// ── NO-CACHE — ბალანსი/ტრანზაქციები ხშირად იცვლება; ვუკრძალავთ
// ბრაუზერს/პროქსის ამ პასუხების დაკეშვას.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ══════════════════════════════════════════════════════════════
// GET /api/wallet/balance
// ══════════════════════════════════════════════════════════════
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT balance_gel, balance_usd, escrow_hold_gel, hold_balance_gel FROM users WHERE id=$1',
      [req.user.id]
    );
    const b    = rows[0];
    const rate = 2.74;

    // უახლოესი hold-ის ვადა — countdown-ისთვის (48სთ ტაიმერი)
    const { rows: nextHoldRows } = await db.query(
      `SELECT hold_until, amount_gel FROM balance_holds
       WHERE user_id=$1 AND released=FALSE
       ORDER BY hold_until ASC LIMIT 1`,
      [req.user.id]
    );
    const nextHold = nextHoldRows[0] || null;
    const now = new Date();
    const holdSecondsLeft = nextHold
      ? Math.max(0, Math.ceil((new Date(nextHold.hold_until) - now) / 1000))
      : 0;

    res.json({
      balance_gel:        Number(b.balance_gel),
      balance_usd:        Number(b.balance_usd),
      escrow_hold_gel:    Number(b.escrow_hold_gel),
      hold_balance_gel:   Number(b.hold_balance_gel),
      available_gel:      Number(b.balance_gel),
      exchange_rate:      rate,
      available_usd:      +(Number(b.balance_gel) / rate).toFixed(2),
      // 48-საათიანი hold — უახლოესი გათავისუფლების დრო, frontend countdown-ისთვის
      next_hold_release_at:      nextHold ? nextHold.hold_until : null,
      next_hold_amount_gel:      nextHold ? Number(nextHold.amount_gel) : 0,
      hold_seconds_left:         holdSecondsLeft,
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/wallet/transactions  — ტრანზ. ისტ.
// ══════════════════════════════════════════════════════════════
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const { rows } = await db.query(`
      SELECT t.*, o.listing_id,
        CASE WHEN l.title IS NOT NULL THEN l.title ELSE NULL END AS listing_title
      FROM transactions t
      LEFT JOIN orders o ON o.id = t.order_id
      LEFT JOIN listings l ON l.id = o.listing_id
      WHERE t.user_id=$1
      ORDER BY t.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.id, Number(limit), offset]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// POST /api/wallet/deposit  — შეტანის მოთხოვნა (Manual BOG)
//
// ⚠️ REFERRAL ANTI-FRAUD შენიშვნა: ეს route მხოლოდ 'pending' ტრანზაქციას
// ქმნის — რეალური ფული ჯერ არ შესულა (ადმინს ჯერ არ დაუდასტურებია ბანკის
// გადარიცხვა). ამიტომ "პირველი დეპოზიტის" რეფერალური ბონუსი აქ ᲐᲠ
// ᲘᲬᲧᲔᲑᲐ — წინააღმდეგ შემთხვევაში ნებისმიერს შეეძლო უსასრულოდ შექმნას
// "დეპოზიტის მოთხოვნები" (არასდროს გადაუხდელი) და გამოეწვია ბონუსი
// ყოველგვარი რეალური ფულის გარეშე. ჯილდოს ტრიგერი მდებარეობს
// admin.js-ში, POST /deposits/:id/confirm-ში (და დეველოპერული ტესტისთვის
// — ქვემოთ, GET /deposit/simulate-ში), სადაც ბალანსი რეალურად იზრდება.
// ══════════════════════════════════════════════════════════════
// ── მოკლე, ადვილად-გადასაწერი უნიკ. კოდის გენერაცია (მაგ. GB-8472) —
// მომხმარებელი ამას წერს ბანკის აპის "დანიშნულების" ველში, რომ ადმინმა
// გადარიცხვა ცალსახად დაუკავშიროს ამ კონკრეტულ მოთხოვნას. 4-ნიშნა
// კოდი საკმარისად მოკლეა მობილურ საბანკო აპში ხელით ჩასაწერად, მაგრამ
// collision-ის რისკის გამო DB-ში უნიკალურობას ვამოწმებთ და კონფლიქტზე
// ხელახლა ვცდილობთ (მაქს. 5-ჯერ, შემდეგ გრძელდება 6-ნიშნაზე).
async function generateShortDepositRef() {
  for (let len = 4; len <= 6; len++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = String(Math.floor(Math.random() * Math.pow(10, len))).padStart(len, '0');
      const ref  = `GB-${code}`;
      const { rows } = await db.query(
        'SELECT 1 FROM transactions WHERE external_ref=$1 LIMIT 1', [ref]
      );
      if (!rows.length) return ref;
    }
  }
  // უკიდურესად ნაკლებსავარაუდო fallback — დროის შტამპზე დაფუძნებული, მაინც უნიკ.
  return `GB-${Date.now().toString(36).toUpperCase()}`;
}

router.post('/deposit', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || Number(amount) < 1)
      return res.status(400).json({ error: 'min_1_gel' });
    if (Number(amount) > 10000)
      return res.status(400).json({ error: 'max_10000_gel' });

    const ref = await generateShortDepositRef();

    const { rows } = await db.query(
      `INSERT INTO transactions(user_id,type,amount_gel,status,payment_method,external_ref,description)
       VALUES($1,'deposit',$2,'pending','BOG',$3,'ბალანსის შეტანა — BOG გადარიცხვა')
       RETURNING id`,
      [req.user.id, Number(amount), ref]
    );

    res.json({
      id:          rows[0].id,
      ref,
      amount: Number(amount),
      iban:        'GE62BG0000000562150681',
      recipient:   'Jumber Shavadze',
      bank:        'Bank of Georgia',
      description: ref,
      eta_hours:   24,
    });

    // ადმინს email — async
    (async () => {
      try {
        await mailer.sendDepositRequestEmail(ADMIN_EMAIL, req.user, amount, ref);
      } catch(e) { console.error('deposit email:', e.message); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/wallet/deposit/:id/screenshot  — ბანკის გადარიცხვის
// დამადასტურებელი სქრინშოტის ატვირთვა უკვე შექმნილ 'pending' deposit
// მოთხოვნაზე (multipart/form-data, ველი: screenshot).
//
// ეს ცალკე endpoint-ია POST /deposit-სგან, რადგან depStep2() ჯერ
// ქმნის მოთხოვნას და აჩვენებს საბანკო დეტალებს (რომ მომხმარებელმა
// ჯერ გადარიცხვა გააკეთოს), ხოლო სქრინშოტს მხოლოდ ამის შემდეგ,
// "მოთხოვნის გაგზავნა" ღილაკზე დაჭერით ტვირთავს — ეს ზუსტად იმეორებს
// admin.js-ის მოლოდინს (screenshot_url ხილული უნდა იყოს Approve-მდე).
// ══════════════════════════════════════════════════════════════
router.post('/deposit/:id/screenshot', requireAuth, depositUpload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'screenshot_required' });
    if (!cloudinary.isConfigured())
      return res.status(503).json({ error: 'image_upload_not_configured' });

    const { rows: tx } = await db.query(
      `SELECT id, user_id, status FROM transactions
       WHERE id=$1 AND type='deposit'`,
      [req.params.id]
    );
    if (!tx.length) return res.status(404).json({ error: 'not_found' });
    if (tx[0].user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    if (tx[0].status !== 'pending') return res.status(400).json({ error: 'not_pending' });

    const result = await cloudinary.uploadBuffer(req.file.buffer, {
      folder:    'gamerbazar/deposits',
      public_id: `deposit_${req.params.id}_${Date.now()}`,
      resource_type: 'image',
    });

    await db.query(
      'UPDATE transactions SET screenshot_url=$1 WHERE id=$2',
      [result.secure_url, req.params.id]
    );

    res.json({ ok: true, screenshot_url: result.secure_url });
  } catch (err) {
    if (err.message === 'only_images')
      return res.status(400).json({ error: 'only_images_allowed' });
    console.error('deposit screenshot upload:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/wallet/deposit/simulate  — DEV ტესტი
// ══════════════════════════════════════════════════════════════
router.get('/deposit/simulate', requireAuth, async (req, res) => {
  if (process.env.NODE_ENV === 'production')
    return res.status(404).json({ error: 'not_found' });

  try {
    const { ref, amount } = req.query;
    let referralResult = { granted: false };
    await db.transaction(async (client) => {
      await client.query(
        "UPDATE transactions SET status='completed' WHERE external_ref=$1", [ref]
      );
      await client.query(
        'UPDATE users SET balance_gel=balance_gel+$1 WHERE id=$2',
        [Number(amount), req.user.id]
      );
      // dev-only სიმულაცია მაინც რეალურად ზრდის ბალანსს, ამიტომ იგივე
      // ატომური ჯილდოს ტრიგერი გამოიყენება, რაც production admin-confirm-ში.
      // dev-only სიმულ.-შიც იგივე ₾10 ზღვარი უნდა მოქმედებდეს, რომ
      // production-ის ქცევა ზუსტად აისახოს ტესტირებისას.
      referralResult = await referral.triggerReferralReward(client, req.user.id, 'deposit', Number(amount));
    });
    res.json({
      ok: true,
      message: `₾${amount} ბალანსზე დაემატა (სიმულ.)`,
      referral_bonus_granted: referralResult.granted,
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/wallet/withdraw  — გამოტ. მოთხოვნა
// ══════════════════════════════════════════════════════════════
router.post('/withdraw', requireAuth, async (req, res) => {
  try {
    const { amount, iban } = req.body;
    if (!amount || !iban)
      return res.status(400).json({ error: 'amount and iban required' });

    const amt = Number(amount);

    // ── ᲗᲐᲜᲮᲘᲡ ᲚᲘᲛᲘᲢᲔᲑᲘ — მინ. ₾20 / მაქს. ₾200 თითო მოთხოვნაზე ──
    if (!amt || amt < WITHDRAW_MIN_GEL || amt > WITHDRAW_MAX_GEL) {
      return res.status(400).json({
        error: 'invalid_withdraw_amount',
        message: `თანხა უნდა იყოს ₾${WITHDRAW_MIN_GEL}-დან ₾${WITHDRAW_MAX_GEL}-მდე`,
        min: WITHDRAW_MIN_GEL, max: WITHDRAW_MAX_GEL,
      });
    }

    // ── ᲡᲘᲮᲨᲘᲠᲘᲡ ᲚᲘᲛᲘᲢᲘ — მაქს. 1 მოთხოვნა 24 საათში. ვამოწმებთ ბოლო
    // withdrawal ტიპის ტრანზაქციის დროს, სტატუსის მიუხედავად (pending/
    // completed/failed) — ეს ისეთივე rate-limit-ია, როგორც ნებისმ.
    // request-level abuse-დაცვა: მოთხოვნის თვითონ გაკეთება იზღუდება,
    // არა მისი საბოლოო შედეგი (წინააღმდეგ შემთხვევაში სწრაფად
    // უარყოფილი მოთხოვნებით შეიძლებოდა ლიმიტის უსასრულოდ გვერდის ავლა). ──
    const { rows: recentWithdrawals } = await db.query(
      `SELECT created_at FROM transactions
       WHERE user_id=$1 AND type='withdrawal'
         AND created_at > NOW() - ($2 * INTERVAL '1 hour')
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, WITHDRAW_COOLDOWN_HOURS]
    );
    if (recentWithdrawals.length) {
      const nextAllowedAt = new Date(
        new Date(recentWithdrawals[0].created_at).getTime() + WITHDRAW_COOLDOWN_HOURS * 3600000
      );
      return res.status(429).json({
        error: 'withdraw_rate_limit',
        message: 'თქვენ უკვე გააკეთეთ გამოტანის მოთხოვნა დღეს. სცადეთ 24 საათის შემდეგ.',
        next_allowed_at: nextAllowedAt,
      });
    }

    const { rows } = await db.query(
      'SELECT balance_gel, hold_balance_gel FROM users WHERE id=$1', [req.user.id]
    );
    const b = rows[0];

    // შენიშვნა: 48სთ hold-ის თანხა hold_balance_gel-შია, არა balance_gel-ში —
    // ანუ balance_gel უკვე მხოლოდ თავისუფლად გასატან თანხას ასახავს, დამატებითი
    // ბლოკირება საჭირო აღარაა (იხ. src/utils/ledger.js).

    // გლობალური 5%-იანი საკომისიო (ledger.js) — ბალანსიდან იკლება ზუსტად
    // მოთხოვნილი თანხა (gross), ხოლო ადმინმა ხელზე უნდა გასცეს მხოლოდ
    // net (95%) — fee ჩაითვლება პლატფორმის შემოსავალში მხოლოდ მას შემდეგ,
    // რაც ადმინი მოთხოვნას რეალურად დაადასტურებს (admin.js /confirm).
    const { gross, fee, net } = ledger.splitCommission(amt);

    if (Number(b.balance_gel) < gross)
      return res.status(402).json({ error: 'insufficient_balance', available: b.balance_gel });

    await db.transaction(async (client) => {
      await client.query(
        'UPDATE users SET balance_gel=balance_gel-$1 WHERE id=$2', [gross, req.user.id]
      );
      await client.query(
        `INSERT INTO transactions
           (user_id,type,amount_gel,gross_amount_gel,net_amount_gel,commission_fee_gel,status,payment_method,description)
         VALUES($1,'withdrawal',$2,$3,$4,$5,'pending','bank',$6)`,
        [req.user.id, -gross, gross, net, fee,
         `გამოტ. IBAN: ${iban.slice(-4)} · ხელზე გაცემა: ₾${net} (საკომ. 5% — ₾${fee})`]
      );
    });

    res.json({ ok: true, amount: gross, commission: fee, net_payout: net, eta: '1-2 სამ. დღე' });

    // ადმინს email — async
    (async () => {
      try {
        await mailer.sendWithdrawRequestEmail(ADMIN_EMAIL, req.user, amount, iban);
      } catch(e) { console.error('withdraw email:', e.message); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
