// src/routes/listings.js
// განცხადებების API

'use strict';

const express = require('express');
const db      = require('../db');
const crypto  = require('crypto');
const multer  = require('multer');
const cloudinary = require('../utils/cloudinary');
const { requireAuth, optionalAuth, requireAdmin } = require('../middleware/auth');
const { requireModerator } = require('../middleware/requireModerator');
const { checkVipStatus }   = require('../middleware/checkVipStatus');

const router = express.Router();

// ══════════════════════════════════════════════════════════════
// NO-CACHE — ეს router-ი მთლიანად დინამიური მონაცემია (განცხადებების
// სია/დეტალი/სტატუსი მუდმივად იცვლება — sold/pending/deleted). ბრაუზერს
// ან შუალედურ პროქსის (CDN, corporate proxy) ვუკრძალავთ ამ პასუხების
// კეშირებას, რომ მომხმარებელმა ძველი (მაგ. უკვე გაყიდული) სტატუსი
// ვერასდროს დაინახოს hard-refresh-მდე.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ── Premium Gaming Fields — Whitelist ვალიდაცია (feature 4) ──────────
// frontend dropdown-ების 1:1 ასლი — client-ის მიერ გამოგზავნილი
// თვითნებური მნიშვნელობა არასდროს ჩაიწერება ბაზაში.
const VALID_PLATFORMS = ['pc', 'mobile', 'playstation', 'xbox', 'nintendo'];
const VALID_REGIONS   = ['global', 'europe', 'north_america', 'asia'];
const VALID_SECURITY  = [
  'full_access', 'mail_included', 'facebook_linked', 'google_linked',
  'apple_linked', 'phone_linked', 'no_link',
];

// ══════════════════════════════════════════════════════════════
// SECURITY FIX — Stored XSS defense-in-depth (title / game / tags)
//
// The frontend already HTML-escapes these fields on output (esc()
// in gamer-market-ge.html / admin.html), but relying on output-encoding
// alone means EVERY current and future consumer of this data (other
// pages, admin exports, emails, a future mobile client, a raw DB dump
// viewed in a spreadsheet, etc.) has to remember to escape correctly —
// one missed spot anywhere is a stored-XSS hole. These fields are all
// plain, short, human-typed text (a listing title, a game name, a
// tag) with zero legitimate use for HTML/script markup, so we strip
// it at write time as well. This is defense-in-depth ON TOP OF
// output-escaping, not a replacement for it — never remove the esc()
// calls on the frontend.
// ══════════════════════════════════════════════════════════════
function sanitizeText(input, maxLen) {
  if (input === undefined || input === null) return input;
  let s = String(input);
  // Strip complete HTML tags, then any stray angle brackets that
  // didn't form a full tag (defeats truncated/broken-tag payloads
  // like "<img src=x onerror=..." with no closing '>').
  s = s.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
  // Collapse control/whitespace noise and trim.
  s = s.replace(/\s+/g, ' ').trim();
  if (maxLen) s = s.slice(0, maxLen);
  return s;
}

// ── ფასის დასაშვები დიაპაზონი — მინ. ₾5 (Escrow-ის ბოროტად გამოყენების
// თავიდან ასაცილებლად: ზოგი მომხმარებელი განზრახ დებდა "1 ₾" სიმბოლურ
// ფასს, "მოვილაპარაკოთო", მაგრამ Escrow-ის გამო მყიდველს შეეძლო
// მყისვე ეყიდა სწორედ ამ 1-ლარიან ფასად — დავები/სისტ. შეცდომები).
// იგივე whitelist გამოიყენება POST /-შიც და PUT /:id-შიც. ──
const MIN_LISTING_PRICE_GEL = 5;
const MAX_LISTING_PRICE_GEL = 50000;

// ── სურათების ატვირთვის middleware — გამოიყენება ორივეგან: POST / (შექმნისას,
// სავალდებულო) და POST /:id/images (მოგვიანებით დამატებისას). Render-ის
// filesystem ephemeral-ია — დისკზე აღარ ვინახავთ, ფაილი მეხსიერებიდან
// (multer memoryStorage) პირდაპირ Cloudinary-ში იტვირთება.
const imgUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: (Number(process.env.MAX_FILE_SIZE_MB) || 3) * 1024 * 1024,
    files: 5,
  },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|webp)/.test(file.mimetype);
    cb(ok ? null : new Error('only_images'), ok);
  },
});

// ვადაგასული VIP სტატუსის საათური cron-ი — ერთხელ, მოდულის პირველ
// ჩატვირთვაზე (იგივე პატერნი, რაც orders.js-ში ledger.startHoldsScheduler()-ს აქვს)
require('../cron/vipExpiry').startVipExpiryScheduler();

// ══════════════════════════════════════════════════════════════
// GET /api/listings/moderation/pending  — მოდერაციის რიგი
// (მოდერატორი + admin) — ყველა pending განცხადება, გამყ. ინფოთი
// ══════════════════════════════════════════════════════════════
router.get('/moderation/pending', requireAuth, requireModerator, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT l.*, u.username AS seller_username, u.email AS seller_email,
             u.display_name AS seller_display_name, u.created_at AS seller_joined_at
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      WHERE l.status = 'pending'
      ORDER BY l.created_at ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('moderation pending list error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/listings/categories  — საჯარო, აქტ. კატეგორიების სია
// (auth არ სჭირდება — გამოიყენება მთავარი საიტის ფილტრებში/
// განცხადების შექმნის ფორმაში, ასევე admin.js-ის კატეგორიების
// მართვის გვერდზეც). ⚠️ /:id-ზე ადრე უნდა იყოს განსაზღვრული,
// წინააღმდეგ შემთხვევაში Express "categories" სტრინგს listing
// id-დ ჩათვლიდა.
// ══════════════════════════════════════════════════════════════
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT slug, name_ka, icon FROM categories WHERE is_active=TRUE ORDER BY sort_order ASC, name_ka ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('categories list error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/listings/suggest  — search autocomplete (game/title)
// ══════════════════════════════════════════════════════════════
router.get('/suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ games: [], titles: [] });

    const [gamesRes, titlesRes] = await Promise.all([
      db.query(`
        SELECT DISTINCT game FROM listings
        WHERE status='active' AND game ILIKE $1
        ORDER BY game LIMIT 5
      `, [`%${q}%`]),
      db.query(`
        SELECT id, title, game, price_gel FROM listings
        WHERE status='active' AND title ILIKE $1
        ORDER BY is_vip DESC, created_at DESC LIMIT 5
      `, [`%${q}%`]),
    ]);

    res.json({
      games: gamesRes.rows.map(r => r.game),
      titles: titlesRes.rows,
    });
  } catch (err) {
    console.error('listings suggest error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/listings  — სია (ფილტრი + pagination)
// ══════════════════════════════════════════════════════════════
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      category, game, subcategory, listing_type, vip,
      platform, region,
      min_price, max_price,
      search, sort = 'newest',
      page = 1, limit = 20,
      seller_id,
      include_sold,
      tag,
    } = req.query;

    // მთავარ გვერდზე მხოლოდ active, profile-ზე ყველა სტატუსი
    // ── 'in_escrow' — SECURITY FIX (overselling race, see orders.js POST /):
    // a listing atomically leaves 'active' and enters 'in_escrow' the moment
    // an order reserves it, so it must stay visible on the seller's own
    // listings view even though it no longer shows in the public feed below. ──
    const statusFilter = seller_id
      ? (include_sold === 'true'
          ? "l.status IN ('active','sold','pending','inactive','rejected','in_escrow')"
          : "l.status IN ('active','pending','inactive','rejected','in_escrow')")
      : "l.status = 'active'";

    const conditions = [statusFilter];
    const params     = [];
    let   p          = 1;

    if (seller_id)    { conditions.push(`l.seller_id = $${p++}`);      params.push(seller_id); }
    if (category)     { conditions.push(`l.category = $${p++}`);       params.push(category); }
    if (game)         { conditions.push(`l.game ILIKE $${p++}`);        params.push(`%${game}%`); }
    // ── Sub-category — ზუსტი (case-insensitive) დამთხვევა კონკრეტულ
    // თამაშზე/სერვისზე (მაგ. category=social + subcategory=TikTok).
    // განსხვავებით ზემოთა `game` პარამეტრისგან (ILIKE, ნაწილობრივი
    // დამთხვევა — Game Hub გვერდისთვის), subcategory ყოველთვის ზუსტი
    // დამთხვევაა, რომ "PUBG" ვერასდროს დაემთხვეს "PUBG Mobile"-ს და
    // პირიქით. Frontend-ის subcategory chips ამ ზუსტ, კატალოგიზებულ
    // სახელებს აგზავნის (იხ. gamer-market-ge.html → SUBCATEGORIES).
    if (subcategory)  { conditions.push(`LOWER(l.game) = LOWER($${p++})`); params.push(subcategory); }
    if (listing_type) { conditions.push(`l.listing_type = $${p++}`);    params.push(listing_type); }
    // ── tag — SA-MP-ის სტილის sub-type ფილტრი (Accounts / In-game Cars /
    // In-game Money), ინახება listings.tags TEXT[] სვეტში. ──
    if (tag)          { conditions.push(`$${p++} = ANY(l.tags)`);       params.push(tag); }
    if (vip === 'true') {
      conditions.push(`l.is_vip = TRUE AND (l.vip_expires_at IS NULL OR l.vip_expires_at > NOW())`);
    }
    // ── Advanced Search: multi-parameter — პლატფორმა + რეგიონი/სერვერი ──
    if (platform && VALID_PLATFORMS.includes(platform)) {
      conditions.push(`l.platform = $${p++}`); params.push(platform);
    }
    if (region && VALID_REGIONS.includes(region)) {
      conditions.push(`l.region = $${p++}`); params.push(region);
    }
    if (min_price)    { conditions.push(`l.price_gel >= $${p++}`);      params.push(min_price); }
    if (max_price)    { conditions.push(`l.price_gel <= $${p++}`);      params.push(max_price); }
    if (search)       {
      // ── Advanced Search: სათაური + აღწერა + კატეგორია + თამაში ერთდროულად ──
      // ერთი საძებნო ველი მოიცავს ყველა ამ სვეტს, რომ იუზერმა
      // "pubg" თუ "boosting" თუ ნაწილობრივი აღწერის სიტყვა მოძებნოს
      // ერთი და იმავე search ბარიდან.
      conditions.push(`(
        l.title       ILIKE $${p} OR
        l.description ILIKE $${p} OR
        l.category    ILIKE $${p} OR
        l.game        ILIKE $${p}
      )`);
      params.push(`%${search}%`); p++;
    }

    const where = conditions.join(' AND ');

    const sortMap = {
      newest:    'l.created_at DESC',
      oldest:    'l.created_at ASC',
      price_asc: 'l.price_gel ASC',
      price_desc:'l.price_gel DESC',
      rating:    'ss.avg_rating DESC NULLS LAST',
    };
    const orderBy = sortMap[sort] || 'l.created_at DESC';

    // VIP ყოველთვის პირველი
    const fullOrder = `l.is_vip DESC, ${orderBy}`;

    const offset = (Number(page) - 1) * Number(limit);
    params.push(Number(limit), offset);

    const { rows } = await db.query(`
      SELECT
        l.*,
        ROUND(l.price_gel * 0.365, 2) AS price_usd,
        u.username     AS seller_username,
        u.display_name AS seller_name,
        u.avatar_url   AS seller_avatar,
        u.is_verified_seller,
        COALESCE(ss.avg_rating, 0)      AS seller_rating,
        COALESCE(ss.review_count, 0)    AS seller_review_count,
        COALESCE(ss.completed_orders, 0)AS seller_completed
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      LEFT JOIN seller_stats ss ON ss.seller_id = l.seller_id
      WHERE ${where}
      ORDER BY ${fullOrder}
      LIMIT $${p++} OFFSET $${p++}
    `, params);

    // სულ რაოდენობა pagination-ისთვის
    const { rows: cnt } = await db.query(
      `SELECT COUNT(*) FROM listings l WHERE ${where}`,
      params.slice(0, params.length - 2)
    );

    res.json({
      listings: rows,
      total:    Number(cnt[0].count),
      page:     Number(page),
      pages:    Math.ceil(Number(cnt[0].count) / Number(limit)),
    });
  } catch (err) {
    console.error('listings GET error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/listings/:id  — ერთი განცხადება
// ══════════════════════════════════════════════════════════════
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        l.*,
        ROUND(l.price_gel * 0.365, 2) AS price_usd,
        u.username, u.display_name, u.avatar_url, u.is_verified_seller,
        COALESCE(ss.avg_rating, 0)   AS seller_rating,
        COALESCE(ss.review_count, 0) AS seller_review_count,
        COALESCE(ss.completed_orders,0) AS seller_completed
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      LEFT JOIN seller_stats ss ON ss.seller_id = l.seller_id
      WHERE l.id = $1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    // ნახვათა რიცხვი
    await db.query('UPDATE listings SET views_count = views_count + 1 WHERE id=$1', [req.params.id]);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/listings  — განცხადების შექმნა
//
// ⚠️ VIP მოდელის რადიკალური ცვლილება: VIP აღარ არის კონკრეტული
// განცხადების თვისება, რომელსაც ცალკე ვყიდულობთ per-listing — ის
// ექაუნთის (User-level) სტატუსია. checkVipStatus middleware-ი აქ
// ადგენს req.isVip / req.vipExpiresAt-ს — თუ მომხმარებლის ანგარიში
// ამჟამად VIP-ია, ახალი განცხადება ავტომატურად, დამატებითი გადახდის
// გარეშე იბადება is_vip=TRUE დროშითა და იმავე ვადით, რაც ანგარიშს
// აქვს. VIP-ის ცალკე ყიდვა აღარ არის listing-ზე მიბმული — იხ.
// POST /api/users/me/vip.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// POST /api/listings  — ახალი განცხადების შექმნა (ატომური, multipart)
//
// ⚠️ არქიტექტურული გამოსწორება: ადრე შექმნა ორ ცალკე მოთხოვნად იყო
// გაყოფილი — (1) POST / ქმნიდა 'pending' მწკრივს ბაზაში სურათების
// გარეშე, (2) frontend შემდეგ ცალკე ხდიდა POST /:id/images-ს. ამ ორ
// ნაბიჯს შორის ნებისმიერი შეფერხება (ქსელის წყვეტა, ჩაკეტილი ტაბი,
// Cloudinary-ის დროებითი შეცდომა) ტოვებდა "ობოლ" pending განცხადებას
// 0-1 ფოტოთი — ის, რაც ადმინის პანელში ჩანდა, ვერასდროს დადასტ.
// ახლა ორივე ნაბიჯი ერთ ატომურ მოთხოვნადაა გაერთიანებული:
// ჯერ სურათები (მინიმუმ 2) ვალიდირდება და იტვირთება Cloudinary-ში,
// და მხოლოდ წარმატების შემთხვევაში იქმნება ბაზაში მწკრივი. თუ
// სურათების ვალიდაცია/ატვირთვა ჩაიშლება — listing საერთოდ არ იქმნება.
// ══════════════════════════════════════════════════════════════
router.post('/', requireAuth, checkVipStatus, imgUpload.array('images', 5), async (req, res) => {
  try {
    let {
      category, game, listing_type, title, description, tags, price_gel,
      platform, region, account_security, clean_email_confirmed,
    } = req.body;

    // ── SECURITY FIX: stored XSS — strip HTML from user-supplied free-text
    // fields before they ever reach the database. See sanitizeText() above. ──
    title = sanitizeText(title, 200);
    game  = sanitizeText(game, 100);

    // ── ANTI-SCAM: "Clean Email" პოლიტიკის სავალდებულო დათანხმება ──
    // multipart/form-data-ზე checkbox მოდის string-ად ('true'/'false'
    // ან საერთოდ არ მოდის თუ მოხსნილია) — არა native boolean-ად,
    // ამიტომ ორივე ფორმას ვამოწმებთ. Frontend-ის ვალიდაციის გვერდის
    // ავლაც ვერანაირად ვერ დაარეგისტრირებს ამ თანხმობის გარეშე
    // განცხადებას (defense-in-depth, იგივე პატერნი რაც 2-ფოტოს
    // მინიმუმს აქვს ზემოთ).
    if (clean_email_confirmed !== 'true' && clean_email_confirmed !== true) {
      return res.status(400).json({
        error: 'clean_email_confirmation_required',
        message: 'სავალდებულოა დაადასტურო, რომ ანგარიშს სუფთა/ახალი ელ-ფოსტა აქვს მიბმული',
      });
    }

    // ── სავალდებულო მინიმუმ 2 ფოტო — პირველი და ყველაზე მკაცრი ბარიერი.
    // ვამოწმებთ ყველაფრის წინ, რომ API-ის პირდაპირი გამოძახებითაც
    // (frontend-ის გვერდის ავლით) ვერანაირად ვერ შეიქმნას 0-1
    // ფოტოიანი განცხადება. ──
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({
        error: 'minimum_2_photos_required',
        message: 'განცხადების დასადებად საჭიროა მინიმუმ 2 ფოტოს ატვირთვა!',
      });
    }

    if (!category || !game || !listing_type || !title || !price_gel) {
      return res.status(400).json({ error: 'required_fields' });
    }
    if (Number(price_gel) < MIN_LISTING_PRICE_GEL || Number(price_gel) > MAX_LISTING_PRICE_GEL) {
      return res.status(400).json({
        error: 'invalid_price',
        message: `ფასი უნდა იყოს ₾${MIN_LISTING_PRICE_GEL}-დან ₾${MAX_LISTING_PRICE_GEL}-მდე`,
        min: MIN_LISTING_PRICE_GEL, max: MAX_LISTING_PRICE_GEL,
      });
    }

    // ── დინამიური კატეგორია — ძველი hardcoded VALID_CATEGORIES მასივის
    // ნაცვლად, ახლა categories ცხრილიდან მოწმდება (იხ. setup.js მიგრაცია
    // + admin.js /categories მართვა). მხოლოდ is_active=TRUE კატეგორიაზეა
    // შესაძლებელი ახალი განცხადების შექმნა. ──
    const { rows: catRows } = await db.query(
      'SELECT 1 FROM categories WHERE slug=$1 AND is_active=TRUE', [category]
    );
    if (!catRows.length) {
      return res.status(400).json({ error: 'invalid_category' });
    }

    // ── Premium Gaming Fields — სავალდებულო: პლატფორმა + რეგიონი/სერვერი ──
    // account_security სურვილისამებრ (ბუსტინგ/ვალუტის განცხადებას "მიბმა"
    // ხშირად საერთოდ არ სჭირდება), მაგრამ თუ მოვიდა, whitelist-ს უნდა ემთხვეოდეს.
    if (!platform || !VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'invalid_platform', allowed: VALID_PLATFORMS });
    }
    if (!region || !VALID_REGIONS.includes(region)) {
      return res.status(400).json({ error: 'invalid_region', allowed: VALID_REGIONS });
    }
    if (account_security && !VALID_SECURITY.includes(account_security)) {
      return res.status(400).json({ error: 'invalid_account_security', allowed: VALID_SECURITY });
    }

    // listing_type ვალიდაცია — service → boosting alias
    const VALID_TYPES = ['account', 'boosting', 'currency', 'service'];
    const normalizedType = listing_type === 'service' ? 'boosting' : listing_type;
    if (!VALID_TYPES.includes(listing_type)) {
      return res.status(400).json({ error: 'invalid_listing_type' });
    }

    if (!cloudinary.isConfigured())
      return res.status(503).json({ error: 'image_upload_not_configured' });

    // ── SA-MP ტიპის ტეგი სავალდებულოა — Accounts / In-game Cars / In-game Money ──
    // (frontend-ი ამას აქცევს required-ად მხოლოდ game==='SA-MP'-ის შემთხვევაში,
    // მაგრამ დამატებით აქაც ვამოწმებთ, defense-in-depth API-ის პირდაპ. გამოძახებისთვის)
    const VALID_SAMP_TAGS = ['Accounts', 'In-game Cars', 'In-game Money'];

    // ── tags ნორმალიზაცია — multipart/form-data-ზე ერთადერთი მნიშვნელობა
    // string-ად მოდის, არა array-დ (მხოლოდ თუ იგივე ველი რამდენჯერმეა
    // გამეორებული, მაშინ მოვა array). ორივე ვარიანტს ვამუშავებთ, რომ
    // TEXT[] სვეტში ყოველთვის სუფთა JS array ჩავწეროთ. ──
    let tagsArr = [];
    if (Array.isArray(tags)) tagsArr = tags.map(t => sanitizeText(t, 40)).filter(Boolean);
    else if (typeof tags === 'string' && tags.trim()) tagsArr = [sanitizeText(tags, 40)].filter(Boolean);

    if (String(game).trim().toUpperCase() === 'SA-MP') {
      const sampTag = tagsArr[0];
      if (!sampTag || !VALID_SAMP_TAGS.includes(sampTag)) {
        return res.status(400).json({ error: 'invalid_samp_tag', allowed: VALID_SAMP_TAGS });
      }
    }

    // ── ავტ. VIP მემკვიდრეობა ექაუნთიდან — უფასოდ ──────────────
    const isVip        = !!req.isVip;
    const vipExpiresAt  = isVip ? req.vipExpiresAt : null;

    // ID-ს წინასწარ ვაგენერირებთ (uuid_generate_v4() default-ის ნაცვლად
    // ექსპლიციტურად ვაწვდით), რომ Cloudinary-ის publicId-ებში
    // listing-ის საბოლოო ID გამოვიყენოთ ჯერ კიდევ INSERT-მდე.
    const listingId = crypto.randomUUID();

    // სურათების ატვირთვა Cloudinary-ში — ბაზაში მწკრივი მხოლოდ ამის
    // წარმატებით დასრულების შემდეგ იქმნება.
    const uploaded = await Promise.all(req.files.map((f, i) => {
      const publicId = `listing_${listingId}_${Date.now()}_${i}_${Math.random().toString(36).slice(2,7)}`;
      return cloudinary.uploadBuffer(f.buffer, {
        folder: 'gamerbazar/listings',
        public_id: publicId,
        resource_type: 'image',
      });
    }));
    const imageUrls = uploaded.map(r => r.secure_url);

    const { rows } = await db.query(`
      INSERT INTO listings
        (id, seller_id, category, game, listing_type, title, description, tags, price_gel, status, is_vip, vip_expires_at,
         platform, region, account_security, images, clean_email_confirmed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14,$15,TRUE)
      RETURNING *
    `, [listingId, req.user.id, category, game, normalizedType, title,
        description || '', tagsArr, Number(price_gel), isVip, vipExpiresAt,
        platform, region, account_security || null, imageUrls]);

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message === 'only_images')
      return res.status(400).json({ error: 'only_images_allowed' });
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(400).json({ error: 'file_too_large' });
    console.error('listing create error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/listings/:id  — განახლება
// ══════════════════════════════════════════════════════════════
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: existing } = await db.query(
      'SELECT * FROM listings WHERE id=$1', [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    const isPrivileged = ['admin', 'moderator'].includes(req.user.role);
    if (existing[0].seller_id !== req.user.id && !isPrivileged) {
      return res.status(403).json({ error: 'forbidden' });
    }

    let { title, game } = req.body;
    const { description, tags, price_gel, platform, region, account_security, category } = req.body;
    let { status } = req.body;

    // ── SECURITY FIX: stored XSS — strip HTML from user-supplied free-text
    // fields before they ever reach the database. See sanitizeText() above. ──
    if (title !== undefined && title !== null) title = sanitizeText(title, 200);
    if (game  !== undefined && game  !== null) game  = sanitizeText(game, 100);

    if (platform && !VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'invalid_platform', allowed: VALID_PLATFORMS });
    }
    if (region && !VALID_REGIONS.includes(region)) {
      return res.status(400).json({ error: 'invalid_region', allowed: VALID_REGIONS });
    }
    if (account_security && !VALID_SECURITY.includes(account_security)) {
      return res.status(400).json({ error: 'invalid_account_security', allowed: VALID_SECURITY });
    }
    // ── Category & Subcategory რედაქტირება — Listing Edit Modal-ის ახალი
    // ველები. კატეგორია იგივე whitelist-ით მოწმდება, რაც POST /-ს აქვს
    // (categories ცხრილი, მხოლოდ is_active=TRUE), რომ არასდროს ჩაიწეროს
    // წაშლილი/გათიშული კატეგორია. `game` (subcategory) თავისუფალი ტექსტია,
    // ისევე როგორც შექმნისას — frontend-ის SUBCATEGORIES chip-ებიდან მოდის,
    // მაგრამ ბექენდი მას ზუსტად ისე ინახავს, როგორც POST /-ზეც ხდება. ──
    if (category !== undefined && category !== null && category !== '') {
      const { rows: catRows } = await db.query(
        'SELECT 1 FROM categories WHERE slug=$1 AND is_active=TRUE', [category]
      );
      if (!catRows.length) {
        return res.status(400).json({ error: 'invalid_category' });
      }
    }
    if (game !== undefined && game !== null && String(game).trim() === '') {
      return res.status(400).json({ error: 'invalid_game', message: 'თამაში/სერვისი ცარიელი ვერ იქნება' });
    }
    // ── ფასის ვალიდაცია — მანამდე ეს endpoint საერთოდ არ ამოწმებდა
    // price_gel-ს, ანუ რედაქტირებისას Escrow-ის "1 ₾" ხარვეზის გვერდის
    // ავლა შესაძლებელი იყო POST /-ის ვალიდაციის მიუხედავადაც ──
    if (price_gel !== undefined && price_gel !== null && price_gel !== '') {
      if (Number(price_gel) < MIN_LISTING_PRICE_GEL || Number(price_gel) > MAX_LISTING_PRICE_GEL) {
        return res.status(400).json({
          error: 'invalid_price',
          message: `ფასი უნდა იყოს ₾${MIN_LISTING_PRICE_GEL}-დან ₾${MAX_LISTING_PRICE_GEL}-მდე`,
          min: MIN_LISTING_PRICE_GEL, max: MAX_LISTING_PRICE_GEL,
        });
      }
    }

    // ── tags ნორმალიზაცია (იხ. POST /-ის იგივე კომენტარი) — undefined
    // ვტოვებთ, თუ საერთოდ არ მოსულა (COALESCE-მა ძველი მნიშვნელობა
    // შეინარჩუნოს), მაგრამ თუ მოსულა, ყოველთვის სუფთა array-დ ვაქცევთ ──
    let tagsArr;
    if (Array.isArray(tags)) tagsArr = tags.map(t => sanitizeText(t, 40)).filter(Boolean);
    else if (typeof tags === 'string' && tags.trim()) tagsArr = [sanitizeText(tags, 40)].filter(Boolean);
    else tagsArr = undefined;

    // ⚠️ უსაფრთხოების გასწორება: ჩვეულებრივ გამყიდველს (არა admin/moderator)
    // აქამდე შეეძლო ამ endpoint-ით ნებისმიერი status გაეგზავნა — მათ შორის
    // პირდაპირ 'active', რაც მთლიანად აუქმებდა მოდერაციის რიგს. ახლა
    // non-privileged იუზერს status-ის შეცვლა შეუძლია მხოლოდ ერთ
    // კონკრეტულ, უსაფრთხო შემთხვევაში — საკუთარი უარყოფილი (rejected)
    // განცხადების ხელახლა მოდერაციაზე გაგზავნისას (rejected → pending).
    if (status !== undefined && !isPrivileged) {
      const allowedResubmit = status === 'pending' && existing[0].status === 'rejected';
      if (!allowedResubmit) status = undefined;
    }

    const params = [
      title, description, tagsArr, price_gel, status, platform, region, account_security,
      category || null, game || null, req.params.id,
    ];
    const { rows } = await db.query(`
      UPDATE listings SET
        title       = COALESCE($1, title),
        description = COALESCE($2, description),
        tags        = COALESCE($3, tags),
        price_gel   = COALESCE($4, price_gel),
        status      = COALESCE($5, status),
        platform    = COALESCE($6, platform),
        region      = COALESCE($7, region),
        account_security = COALESCE($8, account_security),
        category    = COALESCE($9, category),
        game        = COALESCE($10, game),
        rejection_reason = CASE WHEN $5 = 'pending' THEN NULL ELSE rejection_reason END,
        updated_at  = NOW()
      WHERE id=$11
      RETURNING *
    `, params);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// DELETE /api/listings/:id
// ══════════════════════════════════════════════════════════════
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT seller_id FROM listings WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].seller_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }

    // soft delete
    await db.query(
      "UPDATE listings SET status='deleted', updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// ⚠️ POST /api/listings/:id/vip გადატანილია — VIP აღარ არის listing-ზე
// მიბმული "დაწინაურება". ახალი, account-level ყიდვის endpoint-ია
// POST /api/users/me/vip (src/routes/users.js) — ის მხოლოდ
// მომხმარებლის ანგარიშს ანიჭებს VIP სტატუსს (duration_days: 7/30/90),
// listing_id საერთოდ აღარ სჭირდება. ახალი განცხადებები ავტ. იღებენ
// VIP დროშას ზემოთა POST / handler-ში, თუ ანგარიში VIP-ია.
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// POST /api/listings/:id/images  — დამატებითი სურათების ატვირთვა
// (მაქს. 5 სულ ჯამში). შექმნისას სავალდებულო 2 ფოტო უკვე დანართულია
// POST / handler-ში ატომურად — ეს endpoint მხოლოდ დამატებით
// სურათებს ან ძველი (migration-ის წინა) ჩანაწერების შევსებას ემსახურება.
// ══════════════════════════════════════════════════════════════
router.post('/:id/images', requireAuth, imgUpload.array('images', 5), async (req, res) => {
  try {
    if (!cloudinary.isConfigured())
      return res.status(503).json({ error: 'image_upload_not_configured' });
    if (!req.files || !req.files.length)
      return res.status(400).json({ error: 'no_files' });

    // ownership check — ატვირთვამდე, რომ ფუჭად არ დავხარჯოთ Cloudinary quota
    const { rows } = await db.query(
      'SELECT seller_id, images FROM listings WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });

    // ── სავალდებულო მინიმუმ 2 ფოტო ──────────────────────────────
    // პირველი ატვირთვისას (როცა განცხადებას ჯერ საერთოდ არ აქვს
    // სურათი) სულ მცირე 2 ფაილი უნდა მოვიდეს ერთდროულად — ეს
    // ბექენდის მხარეს ამოწმებს frontend-ის ვალიდაციას (იხ. create
    // listing ფორმა), რომ API-ის პირდაპირი გამოძახებითაც ვერ
    // გვერდის ავლით შემოვა 0-1 სურათიანი განცხადება.
    const existingCount = (rows[0].images || []).length;
    if (existingCount === 0 && req.files.length < 2) {
      return res.status(400).json({
        error: 'minimum_2_photos_required',
        message: 'განცხადების დასაპოსტად საჭიროა მინიმუმ 2 ფოტოს ატვირთვა',
      });
    }

    // Cloudinary-ში ატვირთვა — თითოეული ფაილი ცალკე, პარალელურად
    const uploaded = await Promise.all(req.files.map((f, i) => {
      const publicId = `listing_${req.params.id}_${Date.now()}_${i}_${Math.random().toString(36).slice(2,7)}`;
      return cloudinary.uploadBuffer(f.buffer, {
        folder: 'gamerbazar/listings',
        public_id: publicId,
        resource_type: 'image',
      });
    }));
    const newUrls = uploaded.map(r => r.secure_url);

    // არსებულ სურ-ებს ვამატებთ (მაქს. 5 სულ)
    const existing = rows[0].images || [];
    const combined = [...existing, ...newUrls].slice(0, 5);

    await db.query(
      'UPDATE listings SET images=$1, updated_at=NOW() WHERE id=$2',
      [combined, req.params.id]
    );

    res.json({ ok: true, images: combined });
  } catch (err) {
    if (err.message === 'only_images')
      return res.status(400).json({ error: 'only_images_allowed' });
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(400).json({ error: 'file_too_large', max_mb: process.env.MAX_FILE_SIZE_MB || 3 });
    console.error('image upload:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/listings/:id/images  — სურათის წაშლა (Cloudinary-დანაც)
router.delete('/:id/images', requireAuth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    const { rows } = await db.query(
      'SELECT seller_id, images, status FROM listings WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });

    const updated = (rows[0].images || []).filter(u => u !== url);

    // ── მინიმუმ 2 ფოტოს წესი აქაც მოქმედებს — აქტიურ/მოლოდინში
    // მყოფ განცხადებას არ დავანებოთ 2-ზე ნაკლებ სურათამდე დაცლა ──
    if (['active', 'pending'].includes(rows[0].status) && updated.length < 2) {
      return res.status(400).json({
        error: 'minimum_2_photos_required',
        message: 'აქტიურ/მოლოდინში მყოფ განცხადებას მინიმუმ 2 ფოტო მაინც უნდა ჰქონდეს',
      });
    }

    await db.query(
      'UPDATE listings SET images=$1, updated_at=NOW() WHERE id=$2',
      [updated, req.params.id]
    );

    // Cloudinary-დანაც წავშალოთ (ძველი /uploads/... ლოკალური ბმულები — silent skip)
    if (url.includes('res.cloudinary.com')) {
      cloudinary.destroyByUrl(url).catch(() => {});
    }

    res.json({ ok: true, images: updated });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/listings/:id/approve  — Moderator/Admin: pending → active + push
// ══════════════════════════════════════════════════════════════
router.post('/:id/approve', requireAuth, requireModerator, async (req, res) => {
  try {
    // ── Defense-in-depth: 2-ფოტოს მინიმუმი აქაც მოწმდება, imgUpload
    // route-ის ვალიდაციის დამატებით — რომ არცერთ გზით (data ჩანაწერის
    // პირდაპირი მანიპულაციის ჩათვლით) არ დადასტურდეს <2 ფოტოიანი განცხადება ──
    const { rows: pending } = await db.query(
      "SELECT images FROM listings WHERE id=$1 AND status='pending'", [req.params.id]
    );
    if (!pending.length) return res.status(404).json({ error: 'not_found_or_not_pending' });
    if ((pending[0].images || []).length < 2) {
      return res.status(400).json({
        error: 'minimum_2_photos_required',
        message: 'დასადასტურებლად განცხადებას სჭირდება მინიმუმ 2 ფოტო',
      });
    }

    const { rows } = await db.query(
      `UPDATE listings SET status='active', moderated_by=$2, moderated_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_not_pending' });
    res.json(rows[0]);

    // push + email გამყიდველს
    (async () => {
      try {
        const push = require('../utils/push');
        await push.sendToUser(rows[0].seller_id, {
          title: '✅ განცხადება დადასტ.!',
          body: `"${rows[0].title}" — საიტზე გამოჩნდა`,
          url: '/?page=profile',
          tag: `listing-approved-${rows[0].id}`,
        });
      } catch(e) { console.error('approve notify:', e.message); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/listings/:id/reject  — Moderator/Admin: pending → rejected (+ მიზეზი)
// ⚠️ ცვლილება: push-ის გარდა ახლა ასევე იგზავნება Email + ჩატის სისტ.
// შეტყობინება იმავე ზუსტი მიზეზის ტექსტით (იხ. chat.js sendAdminNotice).
router.post('/:id/reject', requireAuth, requireModerator, async (req, res) => {
  try {
    const { reason = '' } = req.body;
    if (!reason.trim()) {
      return res.status(400).json({ error: 'reason_required', message: 'უარყოფის მიზეზი სავალდებულოა' });
    }
    const { rows } = await db.query(
      `UPDATE listings SET status='rejected', rejection_reason=$2, moderated_by=$3, moderated_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id, reason.trim(), req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_not_pending' });
    const listing = rows[0];
    res.json({ ok: true, listing });

    (async () => {
      try {
        const push   = require('../utils/push');
        const mailer = require('../utils/mailer');
        const chat   = require('./chat');

        await push.sendToUser(listing.seller_id, {
          title: '❌ განცხადება უარყოფილია',
          body: reason.trim(),
          url: '/?page=profile',
          tag: `listing-rejected-${listing.id}`,
        });

        const { rows: sellerRows } = await db.query(
          'SELECT id, email, username, display_name, notif_email FROM users WHERE id=$1',
          [listing.seller_id]
        );
        const seller = sellerRows[0];
        if (seller) {
          if (seller.notif_email) {
            await mailer.sendListingRejectedEmail(seller, listing, reason.trim());
          }
          await chat.sendAdminNotice(
            seller.id,
            `❌ თქვენი განცხადება „${listing.title}“ უარყოფილია მოდერაციაში.\nმიზეზი: ${reason.trim()}`
          );
        }
      } catch(e) { console.error('reject notify:', e.message); }
    })();
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/listings/:id/delist  — active/pending → inactive
router.post('/:id/delist', requireAuth, async (req, res) => {
  try {
    const { rows: ex } = await db.query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    if (!ex.length) return res.status(404).json({ error: 'not_found' });
    if (ex[0].seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });
    if (!['active','pending'].includes(ex[0].status))
      return res.status(400).json({ error: 'cannot_delist' });

    const { rows } = await db.query(
      "UPDATE listings SET status='inactive', updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/listings/:id/relist  — inactive → pending
router.post('/:id/relist', requireAuth, async (req, res) => {
  try {
    const { rows: ex } = await db.query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    if (!ex.length) return res.status(404).json({ error: 'not_found' });
    if (ex[0].seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'forbidden' });
    if (ex[0].status !== 'inactive')
      return res.status(400).json({ error: 'not_inactive' });

    const { rows } = await db.query(
      "UPDATE listings SET status='pending', updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;

