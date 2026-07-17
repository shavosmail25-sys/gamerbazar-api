// src/utils/referral.js
// ══════════════════════════════════════════════════════════════
// რეფერალური (აფილიატ) სისტემა — მოკლე პრომო-კოდები + ანტი-ფროდ
// ჯილდოს გაცემის ლოგიკა
//
// ── ᲙᲝᲓᲔᲑᲘᲡ ᲒᲔᲜᲔᲠᲐᲪᲘᲐ (ახალი — ცვლის ძველ UUID-ბმულს) ──────────────
// ადრე რეფერალური "ბმული" უბრალოდ მომხმარებლის საკუთარი UUID (users.id)
// იყო (`?ref=<uuid>`) — გრძელი და არა-წაკითხვადი. ახლა ყოველ
// მომხმარებელს აქვს მოკლე, ადამიანისთვის წასაკითხი კოდი ფორმატით
// `REF-XXXXXX` (username-ის საფუძველზე + შემთხვევითი სუფიქსი,
// უნიკალურობის გარანტიით). იხ. `ensureReferralCode` / `findUserByReferralCode`.
//
// ── ᲯᲘᲚᲓᲝᲡ ᲒᲐᲪᲔᲛᲐ ────────────────────────────────────────────────
// წესები: რეფერერს ჯილდო ერიცხება მხოლოდ მაშინ, როცა რეალური ფული
// ფაქტობრივად შედის ან საბოლოოდ გადაადგილდება სისტემაში:
//   1) "პირველი კვალიფიც. დეპოზიტი" — მხოლოდ მაშინ, როცა ადმინი
//      რეალურად ადასტურებს ბანკის გადარიცხვას (admin.js
//      /deposits/:id/confirm), *არა* დეპოზიტის მოთხოვნის შექმნაზე
//      (wallet.js POST /deposit), რომელიც უბრალოდ 'pending' ჩანაწერს
//      ქმნის და შეიძლება ვერასდროს დადასტურდეს რეალურად. — და ᲛᲮᲝᲚᲝᲓ
//      თუ ერთ ტრანზაქციაში ₾10-ზე მეტია (DEPOSIT_REWARD_THRESHOLD_GEL) —
//      მცირე ($1-ის ტოლი ან ნაკლები ეფექტური "cost") დეპოზიტებით
//      ბონუსის თვითდაფინანსება/abuse რომ არ მოხდეს. ეს ტრიგერი
//      მკაცრად მხოლოდ ბალანსის შევსებაზეა მიბმული — არასდროს
//      ერევა შენაძენის/შეკვეთის/განცხადების route-ებში.
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

const crypto = require('crypto');

const REWARD_AMOUNT_GEL = 1.00;

// ── ᲓᲔᲞᲝᲖᲘᲢᲘᲡ ᲖᲦᲣᲠᲘ (ანტი-ფროდ) — რეფერერს 1₾ ბონუსი ერიცხება
// მხოლოდ მაშინ, თუ მოწვეულმა მეგობარმა ერთ ტრანზაქციაში ₾10-ზე მეტი
// შეიტანა. წინააღმდეგ შემთხვევაში ვინმეს შეეძლო ₾1 შეეტანა და
// მაშინვე ₾1 ბონუსი "მოეგო" რეფერერისთვის — ფაქტობრივად უფასო ფული,
// ნამდვილი ეკონომიკური ღირებულების გარეშე.
const DEPOSIT_REWARD_THRESHOLD_GEL = 10.00;

// ── პრომო-კოდის ფორმატი — `REF-` + 4-24 ალფანუმერული სიმბოლო.
// გამოიყენება როგორც generation-ში (ქვემოთ), ისე მომხმარებლის მიერ
// ხელით შეყვანილი კოდის ვალიდაციისთვის (auth.js). ────────────────
const REFERRAL_CODE_RE = /^REF-[A-Z0-9]{4,24}$/i;

// ── ბაზისური ("readable") ნაწილის აგება username/email-იდან ──────
// მხოლოდ ლათინური ასოები და ციფრები, სათავიდან 8 სიმბოლო, ზედა
// რეგისტრში. Non-latin (ქართული) username-ების შემთხვევაში slug
// ცარიელი გამოვა — მაშინ 'USER' fallback-ს ვიყენებთ.
function slugifyBase(seedText) {
  const slug = String(seedText || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return slug || 'USER';
}

function randomDigits(n) {
  // crypto.randomInt გამოსაყენებელია Math.random()-ზე უსაფრთხოების
  // თვალსაზრისით (კოდები არ უნდა იყოს ადვილად "გამოსაცნობი" ან
  // ჯვარედინად კოლიზირებადი დამტევებაზე დაფუძნებული bad RNG-ით).
  let out = '';
  for (let i = 0; i < n; i++) out += crypto.randomInt(0, 10);
  return out;
}

const FLAG_COLUMN = {
  deposit:  'has_triggered_first_deposit_reward',
  purchase: 'has_triggered_first_purchase_reward',
};

const DESCRIPTION = {
  deposit:  'რეფერალური ბონუსი — მოწვეულმა მეგობარმა პირველი დეპოზიტი შეავსო',
  purchase: 'რეფერალური ბონუსი — მოწვეულმა მეგობარმა პირველი შენაძენი გააკეთა',
};

/**
 * მომხმარებლისთვის უნიკალური `REF-XXXXXX` კოდის გენერაცია და შენახვა,
 * თუ მას ჯერ არ აქვს (users.referral_code IS NULL). Idempotent — თუ
 * კოდი უკვე დაყენებულია, უბრალოდ იმას აბრუნებს ხელახალი გენერაციის
 * გარეშე, ამიტომ უსაფრთხოდ გამოსაძახებელია ყოველ login/registration-ზე
 * ("lazy backfill" ძველი მომხმარებლებისთვისაც, ვისაც migration-მდე
 * შექმნილი ანგარიში აქვს).
 *
 * ანტი-კოლიზიის მექანიზმი: `UPDATE ... WHERE referral_code IS NULL`
 * ატომურად იცავს ორ პარალელურ request-ს შორის race-საგან (ორივემ ვერ
 * "მოიგებს" სხვადასხვა კოდის ჩაწერას ერთსა და იმავე user-ზე), ხოლო
 * UNIQUE constraint-ის დარღვევაზე (`23505` — სხვა user-ს უკვე აქვს
 * ზუსტად ეს კოდი) უბრალოდ ახალი შემთხვევითი სუფიქსით ვცდით ხელახლა.
 *
 * @param {{query: Function}} db - pool ან transaction client
 * @param {string} userId
 * @param {string} seedText - საიდანაც readable ნაწილი აიგება (ჩვეულებრივ username)
 * @returns {Promise<string|null>} საბოლოო referral_code (არსებული ან ახლად შექმნილი)
 */
async function ensureReferralCode(db, userId, seedText) {
  const { rows } = await db.query('SELECT referral_code FROM users WHERE id=$1', [userId]);
  if (!rows.length) return null;
  if (rows[0].referral_code) return rows[0].referral_code;

  const base = slugifyBase(seedText);
  const MAX_ATTEMPTS = 8;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // პირველი მცდელობები მოკლე (2-ციფრიანი) სუფიქსით — ლამაზი და
    // მოკლე კოდისთვის (მაგ. REF-SHAVO25); თუ ბევრი კოლიზია მოხდა,
    // შემდეგ მცდელობებში სუფიქსს ვზრდით საძებნი სივრცის გასაფართოებლად.
    const suffixLen = attempt < 4 ? 2 : 4;
    const candidate = `REF-${base}${randomDigits(suffixLen)}`;

    try {
      const { rows: updated } = await db.query(
        `UPDATE users SET referral_code=$1
         WHERE id=$2 AND referral_code IS NULL
         RETURNING referral_code`,
        [candidate, userId]
      );
      if (updated.length) return updated[0].referral_code;

      // 0 row დაბრუნდა — ან კოდი უკვე დაყენდა (race, სხვა request-მა
      // გაასწრო), ან userId საერთოდ არ არსებობს. გადავამოწმოთ.
      const { rows: recheck } = await db.query(
        'SELECT referral_code FROM users WHERE id=$1', [userId]
      );
      if (recheck.length && recheck[0].referral_code) return recheck[0].referral_code;
      if (!recheck.length) return null;
      // referral_code კვლავ NULL-ია და userId არსებობს — გავაგრძელოთ ცდა.
    } catch (e) {
      // 23505 = unique_violation (candidate-ს უკვე ფლობს სხვა user) —
      // ახალი შემთხვევითი სუფიქსით ვცდით კვლავ; სხვა შეცდომებზე ვისვრით.
      if (e.code !== '23505') throw e;
    }
  }

  throw new Error('[referral] ვერ მოხერხდა უნიკალური კოდის გენერაცია ' + MAX_ATTEMPTS + ' მცდელობის შემდეგ');
}

/**
 * პრომო/რეფერალური კოდით რეფერერის (მოწვევის ავტორის) მოძებნა.
 * ფორმატის ვალიდაცია + ბანზე შემოწმება აქვე ხდება, რომ caller-მა
 * (auth.js) სუფთა id ან null მიიღოს.
 *
 * @param {{query: Function}} db
 * @param {string} code - user-ის მიერ შეყვანილი პრომო კოდი (raw)
 * @returns {Promise<string|null>} რეფერერის id, ან null თუ არასწორი/ვერ მოიძებნა
 */
async function findUserByReferralCode(db, code) {
  if (typeof code !== 'string') return null;
  const clean = code.trim().toUpperCase();
  if (!REFERRAL_CODE_RE.test(clean)) return null;

  const { rows } = await db.query(
    "SELECT id FROM users WHERE referral_code=$1 AND role != 'banned'",
    [clean]
  );
  return rows.length ? rows[0].id : null;
}

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
 * ── ᲓᲔᲞᲝᲖᲘᲢᲘᲡ ᲖᲦᲣᲠᲘ ──────────────────────────────────────────────
 * `rewardType==='deposit'`-ის შემთხვევაში დამატებით მოწოდებული უნდა
 * იყოს `amount` (ამ კონკრეტული დეპოზიტის ოდენობა ₾-ში) და ჯილდო
 * მხოლოდ მაშინ ითვლება "qualifying"-ად, თუ ეს თანხა
 * DEPOSIT_REWARD_THRESHOLD_GEL-ს (₾10) აღემატება. თუ თანხა ზღვარს არ
 * აღწევს, ფუნქცია დაუყოვნებლივ აბრუნებს `{granted:false}` და საერთოდ
 * არ ეხება one-shot დროშას — ანუ ეს კონკრეტული (არაკვალიფიც.)
 * დეპოზიტი არ "წვავს" ერთჯერად შანსს, და მომხმარებლის მომდევნო,
 * უკვე ₾10-ზე მეტი დეპოზიტი მაინც შეძლებს ჯილდოს გამოწვევას.
 * `rewardType==='purchase'`-ზე `amount` საერთოდ არ მოწმდება (ძველი
 * ლოგიკა უცვლელია — ნებისმ. დასრულებული პირველი შენაძენი კმარა).
 *
 * @param {object} client   - db.transaction()-ის pg კლიენტი (აქტიური ტრანზაქციის შიგნით)
 * @param {string} userId   - მომხმარებელი, ვისმა მოქმედებამაც ("ტრიგერმა") შეიძლება ჯილდო გამოიწვიოს
 * @param {'deposit'|'purchase'} rewardType
 * @param {number} [amount] - სავალდებულო rewardType==='deposit'-ზე: ამ დეპოზიტის ოდენობა ₾-ში
 * @returns {Promise<{granted: boolean, referrerId?: string}>}
 */
async function triggerReferralReward(client, userId, rewardType, amount) {
  const flagCol = FLAG_COLUMN[rewardType];
  if (!flagCol) throw new Error(`[referral] უცნობი reward ტიპი: ${rewardType}`);

  // ── STRICT DEPOSIT THRESHOLD — მხოლოდ 'deposit' ტიპზე მოქმედებს.
  // 'purchase' ტიპი ამ შემოწმებას საერთოდ არ გადის (მისი ლოგიკა
  // შენაძენის დასრულებაზეა დამოკიდებული, არა თანხის ოდენობაზე).
  if (rewardType === 'deposit') {
    const depositAmount = Number(amount);
    if (!Number.isFinite(depositAmount) || depositAmount <= DEPOSIT_REWARD_THRESHOLD_GEL) {
      return { granted: false, reason: 'below_threshold' };
    }
  }

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

module.exports = {
  triggerReferralReward,
  REWARD_AMOUNT_GEL,
  DEPOSIT_REWARD_THRESHOLD_GEL,
  ensureReferralCode,
  findUserByReferralCode,
  REFERRAL_CODE_RE,
};
