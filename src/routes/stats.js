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

    const [listings, sellers, volume, categories] = await Promise.all([
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
    ]);

    const catMap = {};
    categories.rows.forEach(r => { catMap[r.category] = Number(r.n); });

    cache = {
      listings_active: Number(listings.rows[0].n),
      sellers_active:  Number(sellers.rows[0].n),
      volume_gel:      Number(volume.rows[0].total),
      categories: {
        mobile:   catMap.mobile   || 0,
        pc:       catMap.pc       || 0,
        social:   catMap.social   || 0,
        boosting: catMap.boosting || 0,
        currency: catMap.currency || 0,
        apps:     catMap.apps     || 0,
      },
      cached_at: new Date().toISOString(),
    };
    cacheTime = now;

    res.json(cache);
  } catch (err) {
    console.error('stats error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
