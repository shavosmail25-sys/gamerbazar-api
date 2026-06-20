// src/db/migrate_constraints.js
// CHECK constraints — უსაფრთხოების გამკაცრება
// ერთხელ გაუშვი: node src/db/migrate_constraints.js
// შემდეგ წაშალე ან .gitignore-ში ჩასვი

'use strict';
require('dotenv').config();
const { pool } = require('./index');

async function migrate() {
  console.log('🔒 CHECK constraints-ის დამატება დაიწყო...\n');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── 1. users.role ─────────────────────────────────────────
    await client.query(`
      ALTER TABLE users
        DROP CONSTRAINT IF EXISTS chk_users_role,
        ADD CONSTRAINT chk_users_role
          CHECK (role IN ('user', 'admin', 'banned'))
    `);
    console.log('✅ users.role CHECK დამატებულია');

    // ── 2. listings.status ────────────────────────────────────
    await client.query(`
      ALTER TABLE listings
        DROP CONSTRAINT IF EXISTS chk_listings_status,
        ADD CONSTRAINT chk_listings_status
          CHECK (status IN ('active', 'sold', 'blocked', 'deleted', 'pending'))
    `);
    console.log('✅ listings.status CHECK დამატებულია');

    // ── 3. orders.status ──────────────────────────────────────
    await client.query(`
      ALTER TABLE orders
        DROP CONSTRAINT IF EXISTS chk_orders_status,
        ADD CONSTRAINT chk_orders_status
          CHECK (status IN ('pending', 'active', 'completed', 'cancelled', 'disputed'))
    `);
    console.log('✅ orders.status CHECK დამატებულია');

    // ── 4. orders.escrow_status ───────────────────────────────
    await client.query(`
      ALTER TABLE orders
        DROP CONSTRAINT IF EXISTS chk_orders_escrow_status,
        ADD CONSTRAINT chk_orders_escrow_status
          CHECK (escrow_status IN ('pending', 'held', 'released', 'refunded', 'disputed'))
    `);
    console.log('✅ orders.escrow_status CHECK დამატებულია');

    // ── 5. disputes.status ────────────────────────────────────
    await client.query(`
      ALTER TABLE disputes
        DROP CONSTRAINT IF EXISTS chk_disputes_status,
        ADD CONSTRAINT chk_disputes_status
          CHECK (status IN ('open', 'resolved'))
    `);
    console.log('✅ disputes.status CHECK დამატებულია');

    // ── 6. disputes.resolution ───────────────────────────────
    await client.query(`
      ALTER TABLE disputes
        DROP CONSTRAINT IF EXISTS chk_disputes_resolution,
        ADD CONSTRAINT chk_disputes_resolution
          CHECK (resolution IS NULL OR resolution IN ('release', 'refund'))
    `);
    console.log('✅ disputes.resolution CHECK დამატებულია');

    await client.query('COMMIT');
    console.log('\n🎉 ყველა constraint წარმატებით დაემატა!');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ შეცდომა — rollback მოხდა:', err.message);
    console.error('   შესაძლოა DB-ში არსებული data ეწინააღმდეგება constraint-ს.');
    console.error('   შეამოწმე: SELECT DISTINCT role FROM users;');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
