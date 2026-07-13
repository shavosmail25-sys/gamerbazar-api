// src/utils/referral.js
// ══════════════════════════════════════════════════════════════
// რეფერალური (აფილიატ) სისტემა — ანტი-ფროდ ჯილდოს გაცემის ლოგიკა
//
// ერთადერთი წესი: რეფერერს ჯილდო ერიცხება მხოლოდ მაშინ, როცა რეალური
// ფული ფაქტობრივად შედის ან საბოლოოდ გადაადგილდება სისტემაში:
//   1) "პირველი დეპოზიტი" — მხოლოდ მაშინ, როცა ადმინი რეალურად
//      ადასტურებს ბანკის გადარიცხვას (admin.js /deposits/:id/confirm),
//      *არა* დეპოზიტის მოთხოვნის შექმნაზე (wallet.js POST /deposit),
//      რომელიც უბრალოდ 'pending' ჩანაწერს ქმნის და შეიძლება
//      ვერასდროს დადასტურდეს რეალურად.
//   2) "პირველი შენაძენი" — მხოლოდ მაშინ, როცა შეკვეთა რეალურად
//      სრულდება (orders.js /:id/confirm — Escrow Release), *არა*
//      შეკვეთის შექმნაზე (POST /api/orders), რომელიც შეიძლება
//      მომხმარებელმა თავადვე გააუქმოს და თანხა უკან დაიბრუნოს
//      (refund) — წინააღმდეგ შემთხვევაში create→cancel loop-ით
//      უსასრულოდ „გამოსაწური" ბონუსი გამოვიდოდა.
//
// ორივე შემთხვევაში ეს ფუნქცია მოწოდებულია მხოლოდ უკვე ღია DB
// ტრანზაქციის (client) შიგნიდან — ატომურობა (ჯილდო + one-shot
// დროშა ერთსა და იმავე ტრანზაქციაშია) გარანტირებულია caller-ის მიერ.
'use strict';

const REWARD_AMOUNT_GEL = 1.00;

const FLAG_COLUMN = {
  deposit:  'has_triggered_first_deposit_reward',
  purchase: 'has_triggered_first_purchase_reward',
};

const DESCRIPTION = {
  deposit:  'რეფერალური ბონუსი — მოწვეულმა მეგობარმა პირველი დეპოზიტი შეავსო',
  purchase: 'რეფერალური ბონუსი — მოწვეულმა მეგობარმა პირველი შენაძენი გააკეთა',
};

/**
 * ატომურად ამოწმებს და (საჭიროების შემთხვევაში) აჯილდოვებს რეფერერს.
 *
 * ანტი-ფროდ მექანიზმი (race condition/double-spending დაცვა):
 *   `UPDATE users SET <flag>=TRUE WHERE id=$1 AND <flag>=FALSE ...`
 * ეს არის ატომური "compare-and-set" — PostgreSQL-ის row-level ლოქინგი
 * გარანტიას იძლევა, რომ ორმა პარალელურმა მოთხოვნამაც კი (მაგ. ორმა
 * თითქმის ერთდროულმა admin-confirm ან order-confirm request-მა)
 * ვერასდროს გაატარონ ერთი და იმავე trigger-ის ბონუსი ორჯერ.
 * `RETURNING referred_by` ცარიელია, თუ flag უკვე TRUE იყო — ანუ
 * ჯილდო ამ ტიპზე ამ userId-სთვის უკვე ერთხელ გაცემულია.
 *
 * ⚠️ დროშა "იწვება" (მიიღება TRUE) მაშინაც კი, თუ თავად რეფერერი
 * იმ მომენტში დაბლოკილია — ეს განზრახულია: ერთხელადი ტრიგერი
 * მუდმივად "იხარჯება" ერთხელ, რომ ბანის მოხსნა/დაბრუნება მოგვიანებით
 * ვერასდროს გახდეს "დაგვიანებული" ბონუსის ხელოვნურად გამოწვევის საშუალება.
 *
 * @param {object} client   - db.transaction()-ის pg კლიენტი (აქტიური ტრანზაქციის შიგნით)
 * @param {string} userId   - მომხმარებელი, ვისმა მოქმედებამაც ("ტრიგერმა") შეიძლება ჯილდო გამოიწვიოს
 * @param {'deposit'|'purchase'} rewardType
 * @returns {Promise<{granted: boolean, referrerId?: string}>}
 */
async function triggerReferralReward(client, userId, rewardType) {
  const flagCol = FLAG_COLUMN[rewardType];
  if (!flagCol) throw new Error(`[referral] უცნობი reward ტიპი: ${rewardType}`);

  const { rows } = await client.query(
    `UPDATE users SET ${flagCol} = TRUE
     WHERE id = $1 AND ${flagCol} = FALSE AND referred_by IS NOT NULL
     RETURNING referred_by`,
    [userId]
  );
  if (!rows.length || !rows[0].referred_by) return { granted: false };

  const referrerId = rows[0].referred_by;

  // რეფერერი უნდა არსებობდეს და არ უნდა იყოს დაბლოკილი ამჟამად —
  // წინააღმდეგ შემთხვევაში ბონუსი უბრალოდ არ გაიცემა (flag მაინც დაწვილია ზემოთ).
  const { rows: refCheck } = await client.query(
    "SELECT id FROM users WHERE id=$1 AND role != 'banned'",
    [referrerId]
  );
  if (!refCheck.length) return { granted: false };

  await client.query(
    `UPDATE users SET
       balance_gel = balance_gel + $1,
       referral_earnings_gel = referral_earnings_gel + $1
     WHERE id = $2`,
    [REWARD_AMOUNT_GEL, referrerId]
  );
  await client.query(
    `INSERT INTO transactions
       (user_id, type, amount_gel, gross_amount_gel, net_amount_gel, commission_fee_gel, description)
     VALUES ($1, 'referral_bonus', $2, $2, $2, 0, $3)`,
    [referrerId, REWARD_AMOUNT_GEL, DESCRIPTION[rewardType]]
  );

  return { granted: true, referrerId };
}

module.exports = { triggerReferralReward, REWARD_AMOUNT_GEL };
