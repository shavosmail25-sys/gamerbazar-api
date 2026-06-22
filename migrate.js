// migrate.js — GamerBazar DB Migration
// გაუშვი: node migrate.js
'use strict';
require('dotenv').config();

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const migrations = [
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE disputes ADD COLUMN IF NOT EXISTS evidence_urls TEXT[] DEFAULT '{}'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_available_at TIMESTAMPTZ`,
];

async function run() {
  const client = await pool.connect();
  try {
    for (const sql of migrations) {
      try {
        await client.query(sql);
        const col = sql.match(/ADD COLUMN IF NOT EXISTS (\S+)/)?.[1];
        console.log(`✅ ${col}`);
      } catch (e) {
        console.error(`⚠️  ${e.message.split('\n')[0]}`);
      }
    }
    console.log('\n✅ Migration დასრულდა!');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
