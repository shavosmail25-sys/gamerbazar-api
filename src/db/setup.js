// src/db/setup.js
// გაუშვი: node src/db/setup.js
// ეს სკრიპტი ქმნის ყველა ცხრილს PostgreSQL-ში

'use strict';
require('dotenv').config();
const { pool } = require('./index');

const SCHEMA = `
-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── USERS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  email             VARCHAR(255) NOT NULL UNIQUE,
  username          VARCHAR(60)  NOT NULL UNIQUE,
  display_name      VARCHAR(100),
  bio               TEXT,
  avatar_url        VARCHAR(500),
  gmail_id          VARCHAR(255) UNIQUE,
  auth_provider     VARCHAR(20)  NOT NULL DEFAULT 'email' CHECK (auth_provider IN ('email','google')),
  password_hash     VARCHAR(255),
  email_verified    BOOLEAN      NOT NULL DEFAULT FALSE,
  balance_gel       NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  balance_usd       NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  escrow_hold_gel   NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  role              VARCHAR(20)  NOT NULL DEFAULT 'user' CHECK (role IN ('user','seller','admin','banned')),
  is_verified_seller BOOLEAN    NOT NULL DEFAULT FALSE,
  discord_handle    VARCHAR(100),
  steam_id          VARCHAR(50),
  notif_email       BOOLEAN      NOT NULL DEFAULT TRUE,
  notif_push        BOOLEAN      NOT NULL DEFAULT FALSE,
  notif_chat        BOOLEAN      NOT NULL DEFAULT TRUE,
  profile_public    BOOLEAN      NOT NULL DEFAULT TRUE,
  show_online       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ
);

-- ── LISTINGS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listings (
  id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  seller_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category       VARCHAR(30)  NOT NULL CHECK (category IN ('mobile','pc','social','boosting','currency')),
  game           VARCHAR(100) NOT NULL,
  listing_type   VARCHAR(20)  NOT NULL CHECK (listing_type IN ('account','item','currency','boosting','service')),
  title          VARCHAR(200) NOT NULL,
  description    TEXT,
  tags           TEXT[]       DEFAULT '{}',
  images         TEXT[]       DEFAULT '{}',
  price_gel      NUMERIC(10,2) NOT NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','sold','blocked','deleted')),
  is_vip         BOOLEAN      NOT NULL DEFAULT FALSE,
  vip_expires_at TIMESTAMPTZ,
  views_count    INT          NOT NULL DEFAULT 0,
  orders_count   INT          NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── ORDERS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id        UUID         NOT NULL REFERENCES listings(id),
  buyer_id          UUID         NOT NULL REFERENCES users(id),
  seller_id         UUID         NOT NULL REFERENCES users(id),
  amount_gel        NUMERIC(10,2) NOT NULL,
  platform_fee_pct  NUMERIC(4,2) NOT NULL DEFAULT 5.00,
  seller_receives   NUMERIC(10,2) NOT NULL,
  escrow_status     VARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (escrow_status IN ('pending','held','released','refunded','disputed')),
  confirm_deadline  TIMESTAMPTZ,
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','cancelled','disputed')),
  buyer_confirmed   BOOLEAN      DEFAULT NULL,
  completed_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  cancel_reason     TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── TRANSACTIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID         NOT NULL REFERENCES users(id),
  order_id       UUID         REFERENCES orders(id),
  type           VARCHAR(30)  NOT NULL,
  amount_gel     NUMERIC(10,2) NOT NULL,
  description    TEXT,
  status         VARCHAR(20)  NOT NULL DEFAULT 'completed',
  payment_method VARCHAR(30),
  external_ref   VARCHAR(255),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── CHAT ROOMS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_rooms (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      UUID        UNIQUE REFERENCES orders(id),
  participant_a UUID        NOT NULL REFERENCES users(id),
  participant_b UUID        NOT NULL REFERENCES users(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── MESSAGES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id      UUID        NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  sender_id    UUID        NOT NULL REFERENCES users(id),
  content      TEXT        NOT NULL,
  content_type VARCHAR(20) NOT NULL DEFAULT 'text',
  is_read      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── REVIEWS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID     PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID     NOT NULL UNIQUE REFERENCES orders(id),
  reviewer_id UUID     NOT NULL REFERENCES users(id),
  seller_id   UUID     NOT NULL REFERENCES users(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── DISPUTES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID        NOT NULL UNIQUE REFERENCES orders(id),
  opened_by   UUID        NOT NULL REFERENCES users(id),
  reason      VARCHAR(50) NOT NULL,
  description TEXT        NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution  VARCHAR(20) CHECK (resolution IN ('release','refund')),
  admin_note  TEXT,
  resolved_by UUID        REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── VIP PURCHASES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vip_purchases (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id    UUID        NOT NULL REFERENCES listings(id),
  user_id       UUID        NOT NULL REFERENCES users(id),
  duration_days INT         NOT NULL,
  price_gel     NUMERIC(8,2) NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── SESSIONS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token VARCHAR(512) NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ  NOT NULL,
  ip_address    INET,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── PUSH SUBSCRIPTIONS (Web Push) ──────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT         NOT NULL UNIQUE,
  p256dh      VARCHAR(255) NOT NULL,
  auth        VARCHAR(255) NOT NULL,
  user_agent  VARCHAR(255),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_listings_seller   ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_game     ON listings(game);
CREATE INDEX IF NOT EXISTS idx_listings_status   ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_price    ON listings(price_gel);
CREATE INDEX IF NOT EXISTS idx_listings_created  ON listings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_buyer      ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller     ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_messages_room     ON messages(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_user           ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_seller    ON reviews(seller_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token    ON sessions(refresh_token);
CREATE INDEX IF NOT EXISTS idx_push_subs_user    ON push_subscriptions(user_id);

-- ── SELLER STATS VIEW ─────────────────────────────────────────
CREATE OR REPLACE VIEW seller_stats AS
SELECT
  u.id              AS seller_id,
  u.username,
  u.display_name,
  u.avatar_url,
  u.is_verified_seller,
  COUNT(DISTINCT r.id)                                    AS review_count,
  COALESCE(ROUND(AVG(r.rating), 2), 0)                   AS avg_rating,
  COUNT(DISTINCT o.id) FILTER (WHERE o.status='completed') AS completed_orders
FROM users u
LEFT JOIN orders  o ON o.seller_id = u.id
LEFT JOIN reviews r ON r.seller_id = u.id
GROUP BY u.id;

-- ── UPDATED_AT TRIGGER ────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_upd    ON users;
DROP TRIGGER IF EXISTS trg_listings_upd ON listings;
DROP TRIGGER IF EXISTS trg_orders_upd   ON orders;
DROP TRIGGER IF EXISTS trg_disputes_upd ON disputes;

CREATE TRIGGER trg_users_upd
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_listings_upd
  BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_orders_upd
  BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_disputes_upd
  BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

async function setupDatabase() {
  console.log('🚀 GamerBazar DB Setup დაიწყო...\n');
  const client = await pool.connect();
  try {
    // სქემის გაშვება
    await client.query(SCHEMA);
    console.log('✅ ყველა ცხრილი შეიქმნა');

    // Admin user (პირველი გაშვებისას)
    const existing = await client.query(
      "SELECT id FROM users WHERE email = 'admin@gamerbazar.ge'"
    );
    if (existing.rowCount === 0) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('Admin123!', 12);
      await client.query(`
        INSERT INTO users
          (email, username, display_name, bio, auth_provider,
           role, is_verified_seller, email_verified, password_hash)
        VALUES
          ('admin@gamerbazar.ge','admin','GamerBazar Admin',
           'პლატფორმის ადმინი','email','admin',TRUE,TRUE,$1)
      `, [hash]);
      console.log('✅ Admin user შეიქმნა');
      console.log('   Email:    admin@gamerbazar.ge');
      console.log('   Password: Admin123!  (შეცვალე!)');
    } else {
      console.log('ℹ️  Admin user უკვე არსებობს');
    }

    console.log('\n🎉 Setup დასრულდა! სერვერი გაშვებისთვის: npm run dev\n');
  } catch (err) {
    console.error('❌ Setup შეცდომა:', err.message);
  } finally {
    client.release();
    // pool.end() — არ ვხურავთ, index.js-ი გამოიყენებს
  }
}

// ← ამ ფაილს პირდაპირ არ ვუშვებთ production-ში
// index.js-ის start()-ი ამოწმებს ცხრილებს
// ეს ფუნქცია migration-ად გამოიყენება უკვე არსებულ DB-ზე
async function runMigrations() {
  const client = await pool.connect();
  try {
    // email_verifications ცხრილი
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      VARCHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_email_ver_token ON email_verifications(token);
    `);

    // password_resets ცხრილი
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      VARCHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pwd_reset_token ON password_resets(token);
    `);

    console.log('✅ Migrations გაიარა');
  } catch(err) {
    console.error('Migration error:', err.message);
  } finally {
    client.release();
  }
}

if (require.main === module) {
  setupDatabase().then(() => runMigrations());
}
module.exports = { setupDatabase, runMigrations };
