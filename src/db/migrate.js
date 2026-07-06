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
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS hold_balance_gel NUMERIC(12,2) NOT NULL DEFAULT 0.00`,
  `CREATE TABLE IF NOT EXISTS otp_codes (
     id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
     email       VARCHAR(255) NOT NULL,
     code_hash   VARCHAR(64)  NOT NULL,
     purpose     VARCHAR(20)  NOT NULL DEFAULT 'login',
     attempts    SMALLINT     NOT NULL DEFAULT 0,
     used        BOOLEAN      NOT NULL DEFAULT FALSE,
     expires_at  TIMESTAMPTZ  NOT NULL,
     created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS balance_holds (
     id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
     user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     order_id     UUID         REFERENCES orders(id),
     amount_gel   NUMERIC(12,2) NOT NULL,
     source       VARCHAR(30)  NOT NULL DEFAULT 'order_confirm',
     hold_until   TIMESTAMPTZ  NOT NULL,
     released     BOOLEAN      NOT NULL DEFAULT FALSE,
     released_at  TIMESTAMPTZ,
     created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_holds_pending ON balance_holds(released, hold_until)`,
  `CREATE INDEX IF NOT EXISTS idx_holds_user ON balance_holds(user_id)`,
  `CREATE TABLE IF NOT EXISTS platform_stats (
     id                 SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
     admin_earnings_gel NUMERIC(14,2) NOT NULL DEFAULT 0.00,
     updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `INSERT INTO platform_stats (id, admin_earnings_gel) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`,
];

async function run() {
  const client = await pool.connect();
  try {
    for (const sql of migrations) {
      try {
        await client.query(sql);
        const label =
          sql.match(/ADD COLUMN IF NOT EXISTS (\S+)/)?.[1] ||
          sql.match(/CREATE TABLE IF NOT EXISTS (\S+)/)?.[1] ||
          sql.match(/CREATE INDEX IF NOT EXISTS (\S+)/)?.[1] ||
          sql.match(/^(INSERT INTO \S+)/)?.[1] ||
          'ok';
        console.log(`✅ ${label}`);
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
