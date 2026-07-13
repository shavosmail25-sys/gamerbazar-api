// src/utils/verifiedSeller.js
'use strict';

// ══════════════════════════════════════════════════════════════
// "ვერიფიცირებული გამყიდველის" ავტომატური სტატუსის სინქრონიზაცია.
//
// პირობა (ორივე ერთდროულად უნდა სრულდებოდეს):
//   • > 10 დასრულებული გაყიდვა  (orders.status = 'completed')
//   • საშუალო შეფასება >= 4.80  (reviews.rating-ის AVG)
//
// მონაცემები seller_stats VIEW-დან მოდის (იხ. setup.js), რომელიც
// ორივე რიცხვს რეალურ დროში ითვლის orders/reviews ცხრილებიდან —
// ცალკე დენორმალიზებული cache არ გვჭირდება.
//
// ეს ფუნქცია უნდა გამოიძახოთ ყოველ ღონისძიებაზე, რომელიც ამ ორ
// რიცხვს ცვლის:
//   • ახალი შეფასება                → reviews.js  (POST /api/reviews)
//   • შეკვეთის დასრულება            → orders.js   (POST /:id/confirm)
//   • დავის გადაწყვეტა "release"-ით → disputes.js და admin.js (/resolve)
//
// სტატუსი ორივე მიმართულებით სრულად ავტომატურია — თუ პირობა
// წყდება (მაგ. საშ. რეიტინგი 4.80-ს ჩამოსცდა ახალი დაბალი
// შეფასების გამო), ბეჯი ავტ. მოიხსნება ამ ფუნქციის მომდევნო
// გამოძახებაზე. მანუალური admin toggle არსად არაა საჭირო.
// ══════════════════════════════════════════════════════════════

const MIN_COMPLETED_SALES = 10;   // მკაცრად > 10 (ანუ 11+ დასრულებული გაყიდვა)
const MIN_AVG_RATING      = 4.80;

/**
 * გამყიდველის seller_stats-ის გადამოწმება და, საჭიროების შემთხვევაში,
 * users.is_verified_seller-ის განახლება.
 *
 * @param {{query: Function}} db - db pool ან db.transaction-ის client (ორივეს
 *   ერთნაირი .query() ინტერფეისი აქვს, ამიტომ ეს ფუნქცია ორივესთან მუშაობს —
 *   ტრანზაქციის შიგნით გამოძახებისას client-ს გადაეცით, რომ იმავე
 *   ტრანზაქციაში ახლახან ჩაწერილი მონაცემიც დაინახოს).
 * @param {string} sellerId
 * @returns {Promise<{isVerified:boolean, changed:boolean, completedOrders:number, avgRating:number}>}
 */
async function checkAndSyncVerifiedSeller(db, sellerId) {
  if (!sellerId) {
    return { isVerified: false, changed: false, completedOrders: 0, avgRating: 0 };
  }

  const { rows } = await db.query(
    `SELECT completed_orders, avg_rating, is_verified_seller
     FROM seller_stats WHERE seller_id = $1`,
    [sellerId]
  );
  if (!rows.length) {
    return { isVerified: false, changed: false, completedOrders: 0, avgRating: 0 };
  }

  const completedOrders = Number(rows[0].completed_orders) || 0;
  const avgRating       = Number(rows[0].avg_rating) || 0;
  const wasVerified      = !!rows[0].is_verified_seller;

  const qualifies = completedOrders > MIN_COMPLETED_SALES && avgRating >= MIN_AVG_RATING;

  if (qualifies !== wasVerified) {
    await db.query('UPDATE users SET is_verified_seller=$1 WHERE id=$2', [qualifies, sellerId]);
  }

  return { isVerified: qualifies, changed: qualifies !== wasVerified, completedOrders, avgRating };
}

module.exports = { checkAndSyncVerifiedSeller, MIN_COMPLETED_SALES, MIN_AVG_RATING };
