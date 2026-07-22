// src/routes/stats.js
// საჯარო სტატისტიკა — auth არ სჭირდება
'use strict';

const express = require('express');
const db      = require('../db');
const router  = express.Router();

// ── NO-CACHE (HTTP-დონე) — server-ის 5-წუთიანი in-memory cache
// (ქვემოთ) განზრახ პატარა TTL-ია დატვირთვის შესამცირებლად, მაგრამ
// ბრაუზერი/შუალედური პროქსი ამას არ უნდა აკეშავდეს დამატებით —
// წინააღმდეგ შემთხვევაში 5-წუთიანი განახლება მომხმარებლისთვის
// გაცილებით მეტ ხანს გამოჩნდება, ვიდრე რეალურად საჭიროა.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// მარტივი in-memory cache — DB-ს ყოველ request-ზე არ ვტვირთავთ
let cache     = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 წუთი

// GET /api/stats
router.get('/', async (req, res) => {
  try {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL) {
      return res.json(cache);
    }

    const [listings, sellers, volume, categories, allCategories, visitsToday] = await Promise.all([
      // სულ active განცხ.
      db.query("SELECT COUNT(*) AS n FROM listings WHERE status='active'"),

      // unique გამყიდვ. (ვისაც completed order აქვს ან active listing)
      db.query(`
        SELECT COUNT(DISTINCT seller_id) AS n
        FROM listings WHERE status IN ('active','sold')
      `),

      // სულ გადახდილი თანხა completed orders-დან
      db.query(`
        SELECT COALESCE(SUM(amount_gel), 0) AS total
        FROM orders WHERE status='completed'
      `),

      // კატ-ების განცხ. რაოდ.
      db.query(`
        SELECT category, COUNT(*) AS n
        FROM listings WHERE status='active'
        GROUP BY category
      `),

      // ── ყველა აქტ. კატეგორია (categories ცხრილიდან) — დინამიური, ადმინის
      // მიერ დამატებული ახალი კატეგორიაც ავტ. გამოჩნდება აქ, ძველი
      // hardcoded 6-სვეტიანი obj-ის ნაცვლად (იხ. admin.js /categories) ──
      db.query('SELECT slug FROM categories WHERE is_active=TRUE ORDER BY sort_order ASC'),

      // ── დღევანდელი უნიკ. ვიზიტორები (hero pill + Global Chat header
      // pill) — იხ. POST /visit ქვემოთ, ჩაწერა xdevice-id-ით ხდება. ──
      db.query('SELECT COUNT(*) AS n FROM site_visits WHERE visit_date = CURRENT_DATE'),
    ]);

    const catMap = {};
    categories.rows.forEach(r => { catMap[r.category] = Number(r.n); });

    const categoriesBreakdown = {};
    allCategories.rows.forEach(r => { categoriesBreakdown[r.slug] = catMap[r.slug] || 0; });

    cache = {
      listings_active: Number(listings.rows[0].n),
      sellers_active:  Number(sellers.rows[0].n),
      volume_gel:      Number(volume.rows[0].total),
      visitors_today:  Number(visitsToday.rows[0].n),
      categories: categoriesBreakdown,
      cached_at: new Date().toISOString(),
    };
    cacheTime = now;

    res.json(cache);
  } catch (err) {
    console.error('stats error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/stats/visit  — დღიური უნიკ. ვიზიტორის დარეგისტრირება
// (auth არ სჭირდება — სტუმარსაც და ავტორიზებულსაც ერთნაირად ეთვლება).
// Frontend ერთხელ, გვერდის ჩატვირთვაზე, localStorage-ში დაგენერირებულ
// device-id-ს (gb_visitor_id) აგზავნის visitor_key-დ. (visit_date,
// visitor_key) PRIMARY KEY თავისთავად უზრუნველყოფს, რომ ერთი device
// დღეში მხოლოდ ერთხელ ჩაითვალოს — ON CONFLICT DO NOTHING უვნებელად
// "იგნორირებს" იმავე დღის განმეორებით request-ებს (page refresh და ა.შ).
// ══════════════════════════════════════════════════════════════
router.post('/visit', async (req, res) => {
  try {
    const key = String(req.body?.visitor_key || '').trim().slice(0, 64);
    if (!key) return res.status(400).json({ error: 'missing_visitor_key' });

    await db.query(
      `INSERT INTO site_visits (visit_date, visitor_key)
       VALUES (CURRENT_DATE, $1)
       ON CONFLICT (visit_date, visitor_key) DO NOTHING`,
      [key]
    );
    // ⚠ ეს ცხრილს ცვლის, მაგრამ ცალკე cache invalidation არ სჭირდება —
    // GET / ისედაც 5წთ-ში ერთხელ ახლდება, ასე რომ ახალი ვიზიტორი
    // მაქსიმუმ 5წთ დაგვიანებით გამოჩნდება ბეჯზე, რაც სრულიად მისაღებია
    // ("დღეს საიტზე" counter-ს წამებში სიზუსტე არ სჭირდება).
    res.json({ ok: true });
  } catch (err) {
    console.error('visit log error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/stats/announcements  — საჯარო, აქტ. საიტის ანონსები
// (auth არ სჭირდება — მთავარი საიტის ბანერისთვის). ვადაგასული
// (expires_at < NOW()) ანონსები აღარ ბრუნდება. მართვა Watchtower-ის
// admin.js-ის /announcements route-ებით ხდება.
// ══════════════════════════════════════════════════════════════
router.get('/announcements', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, title, body, level, created_at
      FROM announcements
      WHERE is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('public announcements error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
