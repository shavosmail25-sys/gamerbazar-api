// src/utils/ledger.js
// ფინანსური დამხმარეები:
//  1) გამყიდველის შემოსავლის ჩარიცხვა 48-საათიანი hold-ით (anti-fraud)
//  2) საიტის 5%-იანი საკომისიოს აღრიცხვა platform_stats.admin_earnings_gel-ში
//  3) ვადაგასული hold-ების ავტომატური გათავისუფლება (hold_balance_gel → balance_gel)
'use strict';

const db = require('../db');

const HOLD_HOURS = 48;

// ── გამყიდველს ემატება თანხა hold_balance_gel-ზე + balance_holds ჩანაწერი ──
// client — db.transaction-ის შიდა client (ატომურობისთვის, იძახება არსებული ტრანზაქციის ფარგლებში)
async function creditSellerWithHold(client, { sellerId, orderId, amountGel, source }) {
  const amount = Number(amountGel);
  if (!(amount > 0)) return null;

  const holdUntil = new Date(Date.now() + HOLD_HOURS * 60 * 60 * 1000);

  await client.query(
    'UPDATE users SET hold_balance_gel = hold_balance_gel + $1 WHERE id=$2',
    [amount, sellerId]
  );
  await client.query(`
    INSERT INTO balance_holds(user_id, order_id, amount_gel, source, hold_until)
    VALUES ($1,$2,$3,$4,$5)
  `, [sellerId, orderId || null, amount, source || 'order_confirm', holdUntil]);

  return holdUntil;
}

// ── საიტის საკომისიოს დამატება admin_earnings_gel-ზე (5% ყოველი წარმატ. გაყიდვიდან) ──
async function recordPlatformFee(client, feeGel) {
  const fee = Number(feeGel);
  if (!(fee > 0)) return;
  await client.query(`
    INSERT INTO platform_stats(id, admin_earnings_gel, updated_at)
    VALUES (1, $1, NOW())
    ON CONFLICT (id) DO UPDATE SET
      admin_earnings_gel = platform_stats.admin_earnings_gel + $1,
      updated_at = NOW()
  `, [fee]);
}

// ── ვადაგასული hold-ების გათავისუფლება — hold_balance_gel → balance_gel ──
async function releaseMaturedHolds() {
  try {
    const { rows } = await db.query(
      `SELECT * FROM balance_holds WHERE released=FALSE AND hold_until <= NOW() ORDER BY hold_until ASC LIMIT 200`
    );
    if (!rows.length) return;

    for (const hold of rows) {
      await db.transaction(async (client) => {
        // row-level დაცვა — თუ სხვა პროცესმა უკვე გაათავისუფლა, გამოვტოვოთ
        const { rowCount } = await client.query(
          'UPDATE balance_holds SET released=TRUE, released_at=NOW() WHERE id=$1 AND released=FALSE',
          [hold.id]
        );
        if (!rowCount) return;

        await client.query(
          `UPDATE users SET
             hold_balance_gel = GREATEST(hold_balance_gel - $1, 0),
             balance_gel      = balance_gel + $1
           WHERE id=$2`,
          [hold.amount_gel, hold.user_id]
        );
        await client.query(`
          INSERT INTO transactions(user_id, order_id, type, amount_gel, description)
          VALUES ($1,$2,'hold_release',$3,'48სთ hold გათავისუფლდა — თანხა ხელმისაწვდომია')
        `, [hold.user_id, hold.order_id, hold.amount_gel]);
      });
    }
    console.log(`💰 ${rows.length} hold გათავისუფლდა (48სთ ვადა გავიდა)`);
  } catch (e) {
    console.error('releaseMaturedHolds error:', e.message);
  }
}

// ── ერთხელ-გაშვების scheduler — მოდულის პირველ require-ზე იწყებს მუშაობას ──
let schedulerStarted = false;
function startHoldsScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  releaseMaturedHolds().catch(() => {});
  setInterval(() => releaseMaturedHolds().catch(() => {}), 5 * 60 * 1000); // ყოველ 5 წუთში
}

module.exports = {
  HOLD_HOURS,
  creditSellerWithHold,
  recordPlatformFee,
  releaseMaturedHolds,
  startHoldsScheduler,
};
