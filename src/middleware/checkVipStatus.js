// src/middleware/checkVipStatus.js
// VIP მომხმარებლის სტატუსის შემოწმება — req.isVip-ის დაყენება
'use strict';

const db = require('../db');

// ⚠️ შენიშვნა (მნიშვნელოვანი): ამჟამად POST /api/listings-ზე განცხადების
// დამატება ისედაც უფასოა ყველა მომხმარებლისთვის — listings.js-ის კოდში
// არსად არ იკლებოდა თანხა request-ის დროს (მხოლოდ /:id/vip-ის ცალკე
// "დაწინაურება" ღირს ფული). ანუ დღეს ეს middleware არაფერს "აუფასურებს"
// რეალურად, რადგან გასათავისუფლებელი საფასური არ არსებობს.
//
// ის მაინც სასარგებლოა, რადგან: (ა) req.isVip ხელმისაწვდომი ხდება
// ნებისმიერ route-ში ერთი დამატებითი query-ის გარეშე, და (ბ) თუ
// მომავალში დაამატებ განცხადების საფასურს/დღიურ ლიმიტს non-VIP
// მომხმარებლებისთვის, საკმარისია route-ში `if (!req.isVip) {...}`.
//
// DB-დან პირდაპირ ვამოწმებთ (და არა req.user-იდან ვენდობით), რადგან
// VIP სტატუსს ყოველ საათში cron ხსნის (იხ. src/cron/vipExpiry.js) —
// თუ requireAuth middleware-ს req.user JWT-გადამოწმებისას სესიის
// დასაწყისში ერთხელ მოაქვს/ქეშავს, 30-დღიანი ტოკენის განმავლობაში
// მოძველებული აღმოჩნდება. ერთი მარტივი query ამის თავიდან აცილებას
// უფრო იაფი უჯდება, ვიდრე ვადაგასული VIP-ის უფასო სარგებლის მინიჭება.
async function checkVipStatus(req, res, next) {
  try {
    if (!req.user?.id) {
      req.isVip = false;
      req.vipExpiresAt = null;
      return next();
    }

    const { rows } = await db.query(
      'SELECT is_vip, vip_expires_at FROM users WHERE id=$1',
      [req.user.id]
    );
    const u = rows[0];

    // VIP მხოლოდ მაშინაა რეალურად აქტიური, თუ დროშაც true-ა და ვადაც
    // ჯერ არ ამოწურულა — fallback დაცვა იმ საათამდე, სანამ cron-ი
    // ავტომატურად არ მოხსნის ვადაგასულ სტატუსებს
    req.isVip = !!(u && u.is_vip && u.vip_expires_at && new Date(u.vip_expires_at) > new Date());

    // req.vipExpiresAt — მომხმარებლის ანგარიშის VIP ვადა, საჭიროა route-ებში
    // (მაგ. POST /api/listings), რომ ახალ განცხადებას პირდაპირ იმავე
    // ვადით მოვნიშნოთ is_vip=TRUE, ცალკე DB query-ის გარეშე.
    req.vipExpiresAt = req.isVip ? u.vip_expires_at : null;

    next();
  } catch (err) {
    console.error('checkVipStatus error:', err.message);
    req.isVip = false; // შეცდომისას fail-safe — ჩვეულებრივ (non-VIP) რეჟიმზე
    req.vipExpiresAt = null;
    next();
  }
}

module.exports = { checkVipStatus };
