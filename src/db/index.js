// src/db/index.js
// PostgreSQL კავშირი — pg Pool გამოყენებით

'use strict';

const { Pool } = require('pg');

// Pool ქმნის მრავალ კავშირს ეფექტური გამოყენებისთვის
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }  // Supabase / Railway SSL
    : false,
  max: 10,              // მაქ. კავშირების რაოდ.
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// კავშირის შემოწმება გაშვებისას
pool.on('connect', () => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('✅ PostgreSQL-თან დაკავშირდა');
  }
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL შეცდომა:', err.message);
});

// ── query helper ─────────────────────────────────────────────
// გამოყენება: const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [id])
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const dur = Date.now() - start;
    if (process.env.NODE_ENV === 'development' && dur > 200) {
      console.log(`⚠️  ნელი query (${dur}ms):`, text.slice(0, 80));
    }
    return result;
  } catch (err) {
    console.error('DB query შეცდომა:', err.message);
    throw err;
  }
}

// ── transaction helper ───────────────────────────────────────
// ატომური ოპ-ებისთვის (Escrow, Wallet)
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── კავშირის ტესტი ───────────────────────────────────────────
async function testConnection() {
  try {
    const { rows } = await query('SELECT NOW() as time, version() as ver');
    console.log('🗄️  DB დრო:', rows[0].time);
    console.log('🗄️  PostgreSQL:', rows[0].ver.split(' ')[0], rows[0].ver.split(' ')[1]);
    return true;
  } catch (err) {
    console.error('❌ DB კავშირი ვერ მოხდა:', err.message);
    return false;
  }
}

module.exports = { query, transaction, pool, testConnection };
