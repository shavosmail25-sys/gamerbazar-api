// fix_delivered_constraint.js
// გაუშვი: node fix_delivered_constraint.js
// orders.status CHECK-ში 'delivered' დამატება

'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function fix() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ძველი constraint წაშლა + ახალი 'delivered'-ით
    await client.query(`
      ALTER TABLE orders
        DROP CONSTRAINT IF EXISTS chk_orders_status,
        ADD CONSTRAINT chk_orders_status
          CHECK (status IN ('pending', 'active', 'delivered', 'completed', 'cancelled', 'disputed'))
    `);
    console.log('✅ orders.status constraint განახლდა — delivered დაემატა');

    await client.query('COMMIT');
    console.log('🎉 დასრულდა!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ შეცდომა:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

fix();
