// src/cron/vipExpiry.js
// ყოველსაათური cron — ვადაგასული VIP სტატუსის მოხსნა (listings + users)
'use strict';

const cron = require('node-cron');
const db   = require('../db');

// ერთი ატომური ტრანზაქცია — listings და users ერთდროულად ვასუფთავებთ,
// რომ ორ ცხრილს შორის სტატუსი არასდროს "დაშორდეს" ერთმანეთს ნახევარგზაზე
// წარუმატებელი run-ის შემთხვევაშიც კი.
async function expireVips() {
  try {
    let listingsCount = 0;
    let usersCount    = 0;

    await db.transaction(async (client) => {
      const listingsRes = await client.query(`
        UPDATE listings
        SET is_vip = FALSE, vip_expires_at = NULL, updated_at = NOW()
        WHERE is_vip = TRUE AND vip_expires_at IS NOT NULL AND vip_expires_at < NOW()
      `);
      const usersRes = await client.query(`
        UPDATE users
        SET is_vip = FALSE, vip_expires_at = NULL
        WHERE is_vip = TRUE AND vip_expires_at IS NOT NULL AND vip_expires_at < NOW()
      `);
      listingsCount = listingsRes.rowCount;
      usersCount    = usersRes.rowCount;
    });

    if (listingsCount || usersCount) {
      console.log(`⏰ VIP expiry cron: ${listingsCount} განცხადებას და ${usersCount} მომხმარებელს მოეხსნა VIP სტატუსი`);
    }
  } catch (err) {
    console.error('❌ VIP expiry cron error:', err.message);
  }
}

// გამოძახება ერთხელ, აპლიკაციის გაშვებისას (listings.js-იდან) — modul-ი
// Node-ის მიერ ქეშირდება, ამიტომ ორჯერ დარეგისტრირება არ ხდება, თუნდაც
// listings.js რამდენჯერმე იყოს require-ილი.
let started = false;

function startVipExpiryScheduler() {
  if (started) return;
  started = true;

  // ყოველ საათში, საათის დასაწყისში (წუთი 0)
  cron.schedule('0 * * * *', expireVips);

  // სერვერის გაშვებისთანავე ერთხელაც გავუშვათ — deploy-ის შემდეგ ან
  // downtime-ის დროს "გაცურებული" ვადები არ დაელოდება მთელი საათის ბოლომდე
  expireVips();

  console.log('⏰ VIP expiry cron job გაშვებულია (ყოველ საათში ერთხელ)');
}

module.exports = { startVipExpiryScheduler, expireVips };
