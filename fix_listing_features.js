// fix_listing_features.js
// გაუშვი: node fix_listing_features.js
// listings ცხრილში original_price + inactive status constraint განახლება

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

    // 1. original_price სვეტი
    await client.query(`
      ALTER TABLE listings ADD COLUMN IF NOT EXISTS original_price NUMERIC(10,2) DEFAULT NULL
    `);
    console.log('✅ original_price სვეტი დაემატა');

    // 2. status constraint-ში inactive დამატება
    await client.query(`
      ALTER TABLE listings
        DROP CONSTRAINT IF EXISTS chk_listings_status,
        ADD CONSTRAINT chk_listings_status
          CHECK (status IN ('active','sold','blocked','deleted','pending','inactive'))
    `);
    console.log('✅ listings.status constraint განახლდა — inactive დაემატა');

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
