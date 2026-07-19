// src/db/setup.js
// გაუშვი: node src/db/setup.js
// ეს სკრიპტი ქმნის ყველა ცხრილს PostgreSQL-ში

'use strict';
require('dotenv').config();
const { pool } = require('./index');
const referral = require('../utils/referral');

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
  auth_provider     VARCHAR(20)  NOT NULL DEFAULT 'email',
  password_hash     VARCHAR(255),  -- აღარ გამოიყენება (OTP-ზე გადავედით) — სვეტი დარჩა ძვ. მონაცემებისთვის
  email_verified    BOOLEAN      NOT NULL DEFAULT FALSE,
  balance_gel           NUMERIC(12,2) NOT NULL DEFAULT 0.00,   -- ხელმისაწვდომი ბალანსი (თავისუფლად გასატანი)
  balance_usd           NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  hold_balance_gel      NUMERIC(12,2) NOT NULL DEFAULT 0.00,   -- 48სთ hold-ში მყოფი თანხა (იხ. balance_holds)
  escrow_hold_gel       NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  balance_available_at  TIMESTAMPTZ,   -- legacy — აღარ გამოიყენება ახალ hold სისტემაში
  role              VARCHAR(20)  NOT NULL DEFAULT 'user',
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
  category       VARCHAR(30)  NOT NULL,
  game           VARCHAR(100) NOT NULL,
  listing_type   VARCHAR(20)  NOT NULL,
  title          VARCHAR(200) NOT NULL,
  description    TEXT,
  tags           TEXT[]       DEFAULT '{}',
  images         TEXT[]       DEFAULT '{}',
  price_gel      NUMERIC(10,2) NOT NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active',
  is_vip         BOOLEAN      NOT NULL DEFAULT FALSE,
  vip_expires_at TIMESTAMPTZ,
  views_count    INT          NOT NULL DEFAULT 0,
  orders_count   INT          NOT NULL DEFAULT 0,
  moderated_by     UUID         REFERENCES users(id),   -- ვინ დაამტკიცა/უარყო (moderator/admin)
  moderated_at     TIMESTAMPTZ,                          -- როდის იქნა განხილული
  rejection_reason TEXT,                                 -- უარყოფის მიზეზი (მოდერატორის პანელი)
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
  escrow_status     VARCHAR(20)  NOT NULL DEFAULT 'pending',
  confirm_deadline  TIMESTAMPTZ,
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending',
  buyer_confirmed   BOOLEAN      DEFAULT NULL,
  delivered_at      TIMESTAMPTZ,
  disputed_at       TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  cancel_reason     TEXT,
  reminder_24h_sent BOOLEAN      NOT NULL DEFAULT FALSE,
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
  gross_amount_gel   NUMERIC(12,2),   -- საკომისიოს დაანგარიშებამდე თანხა
  net_amount_gel     NUMERIC(12,2),   -- საკომისიოს გამოკლებით/დამატებით სუფთა თანხა
  commission_fee_gel NUMERIC(12,2),   -- 5%-იანი პლატფორმის საკომისიო (თუ ეხება)
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
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      UUID        NOT NULL UNIQUE REFERENCES orders(id),
  opened_by     UUID        NOT NULL REFERENCES users(id),
  reason        VARCHAR(50) NOT NULL,
  description   TEXT        NOT NULL,
  evidence_urls TEXT[]      DEFAULT '{}',
  status        VARCHAR(20) NOT NULL DEFAULT 'open',
  resolution    VARCHAR(20),
  admin_note    TEXT,
  resolved_by   UUID        REFERENCES users(id),
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── VIP PURCHASES ─────────────────────────────────────────────
-- ⚠️ listing_id აღარ არის სავალდებულო — VIP ყიდვა ახლა account-level-ია
-- (POST /api/users/me/vip), listing_id-ის გარეშე. სვეტი NULL-ადი დარჩა
-- უკუთავსებადობისთვის ძველ, listing-დაკავშირებულ ჩანაწერებთან.
CREATE TABLE IF NOT EXISTS vip_purchases (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id    UUID        REFERENCES listings(id),
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

-- ── OTP CODES (პაროლის გარეშე შესვლა) ──────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       VARCHAR(255) NOT NULL,
  code_hash   VARCHAR(64)  NOT NULL,
  purpose     VARCHAR(20)  NOT NULL DEFAULT 'login',
  attempts    SMALLINT     NOT NULL DEFAULT 0,
  used        BOOLEAN      NOT NULL DEFAULT FALSE,
  expires_at  TIMESTAMPTZ  NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── BALANCE HOLDS (48-საათიანი ჰოლდი გაყიდვის შემდეგ) ──────────
CREATE TABLE IF NOT EXISTS balance_holds (
  id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id     UUID         REFERENCES orders(id),
  amount_gel   NUMERIC(12,2) NOT NULL,
  source       VARCHAR(30)  NOT NULL DEFAULT 'order_confirm',
  hold_until   TIMESTAMPTZ  NOT NULL,
  released     BOOLEAN      NOT NULL DEFAULT FALSE,
  released_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── PLATFORM STATS (საიტის წმინდა მოგება — admin_earnings) ─────
CREATE TABLE IF NOT EXISTS platform_stats (
  id                 SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  admin_earnings_gel NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO platform_stats (id, admin_earnings_gel) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

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
CREATE INDEX IF NOT EXISTS idx_otp_email         ON otp_codes(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_holds_pending     ON balance_holds(released, hold_until);
CREATE INDEX IF NOT EXISTS idx_holds_user        ON balance_holds(user_id);
-- ვადაგასული VIP-ების საათური cron-ისთვის — partial index, მხოლოდ VIP მწკრივებზე
-- ⚠️ idx_users_vip_expiry აქ აღარაა: users.is_vip ამ batch-ში ჯერ არ არსებობს
-- (ის მხოლოდ ქვემოთ, migrations loop-ში ემატება ALTER TABLE-ით) — ინდექსი
-- listings-ისთვის კი აქ რჩება, რადგან listings.is_vip თავიდანვეა CREATE TABLE-ში.
CREATE INDEX IF NOT EXISTS idx_listings_vip_expiry ON listings(vip_expires_at) WHERE is_vip = TRUE;

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

    // ── Migration: ახალი სვეტები (IF NOT EXISTS — უსაფრთხო განახლება) ──
    const migrations = [
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at      TIMESTAMPTZ`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS disputed_at       TIMESTAMPTZ`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE disputes ADD COLUMN IF NOT EXISTS evidence_urls   TEXT[] DEFAULT '{}'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_available_at TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS hold_balance_gel NUMERIC(12,2) NOT NULL DEFAULT 0.00`,
      // ── მოდერაციის სვეტები listings-ზე — approve/reject 500-ს იძლეოდა
      // ამათ გარეშე, რადგან listings.js ცდილობდა ჩაეწერა სვეტებში
      // რომლებიც ბაზურ CREATE TABLE-ში აღარ იყო ჩართული ((IF NOT EXISTS
      // — უსაფრთხოა უკვე არსებულ ცხრილზეც, არაფერს გადააწერს) ──
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS moderated_by     UUID REFERENCES users(id)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS moderated_at     TIMESTAMPTZ`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS rejection_reason TEXT`,
      // ── Commission audit trail — ყოველ საკომისიო-შემცველ ტრანზაქციაზე
      // ჩანს ზუსტად რა თანხიდან (gross), რამდენი წავიდა საკომისიოში (fee)
      // და რამდენი დარჩა/გაიცა სუფთა (net) ──
      `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS gross_amount_gel   NUMERIC(12,2)`,
      `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS net_amount_gel     NUMERIC(12,2)`,
      `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS commission_fee_gel NUMERIC(12,2)`,
      // ── VIP სისტემა — User მოდელთან სინქრონიზაცია ("სანდო გამყიდველის" ბეჯი) ──
      // listings-ს already ჰქონდა is_vip/vip_expires_at; ეს იგივე ორი ველი
      // ემატება users-საც, რომ VIP სტატუსი კონკრეტულ განცხადებას კი არა,
      // მთლიან პროფილს დაუკავშირდეს. + total_sales_gel — გამყიდველის
      // სანდოობის საჯარო მაჩვენებელი (მთლიანი, gross გაყიდვების მოცულობა).
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_vip           BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_expires_at   TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_sales_gel  NUMERIC(12,2) NOT NULL DEFAULT 0.00`,
      // ── users.is_vip ინდექსი აქაა გადმოტანილი (SCHEMA batch-იდან) — მხოლოდ
      // ზემოთა ორი ALTER-ის შემდეგ არსებობს is_vip სვეტი, ამიტომ ინდექსიც
      // მხოლოდ მათ შემდეგ შეიძლება აშენდეს, არა ერთდროულად CREATE TABLE-თან.
      `CREATE INDEX IF NOT EXISTS idx_users_vip_expiry ON users(vip_expires_at) WHERE is_vip = TRUE`,
      // ── VIP მოდელის რადიკალური ცვლილება: VIP ყიდვა აღარ არის
      // კონკრეტულ განცხადებაზე მიბმული (POST /api/users/me/vip,
      // ცალკე listing_id აღარ სჭირდება) — ამიტომ vip_purchases.listing_id
      // ძველი NOT NULL შეზღუდვა ვხსნით. თავად სვეტი ისტორიის
      // შესანარჩუნებლად რჩება ცხრილში (ძველი listing-დაკავშირებული
      // ჩანაწერებისთვის), უბრალოდ ახალ ჩანაწერებში NULL იქნება.
      `ALTER TABLE vip_purchases ALTER COLUMN listing_id DROP NOT NULL`,
      // ── Premium Gaming Fields — პლატფორმა / რეგიონი-სერვერი / მიბმები ──
      // სამივე სვეტი სავალდებულო არაა ძველი ჩანაწერებისთვის (migration-ი
      // არსებულ მწკრივებს არ არღვევს), ახალ განცხადებებზე კი listings.js
      // ვალიდაციით მოითხოვება. platform/region ინდექსდება, რადგან
      // ძებნის/ფილტრის ფორმაში ორივეზე ხშირი query მოსალოდნელია.
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS platform          VARCHAR(20)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS region            VARCHAR(20)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS account_security  VARCHAR(40)`,
      `CREATE INDEX IF NOT EXISTS idx_listings_platform ON listings(platform)`,
      `CREATE INDEX IF NOT EXISTS idx_listings_region   ON listings(region)`,
      // ── REFERRAL / AFFILIATE სისტემა — ანტი-ფროდ state tracking ──────────
      // referred_by: ვინ მოიწვია ეს მომხმარებელი. იწერება მხოლოდ ერთხელ,
      // ანგარიშის შექმნის მომენტში (auth.js verify-otp / google callback) —
      // შემდეგ არასდროს იცვლება, ამიტომ ხელახალი login ვერ "გადააწერს"
      // ან ვერ დაამატებს რეფერალს უკვე არსებულ ანგარიშზე.
      // has_triggered_first_deposit_reward / has_triggered_first_purchase_reward:
      // ორივე default FALSE — ერთხელადი "one-shot" დროშები, გამოიყენება
      // ატომური UPDATE...WHERE flag=FALSE RETURNING პატერნით
      // (იხ. src/utils/referral.js) — race condition-ისა და double-spending-ის
      // საწინააღმდეგოდ.
      // referral_earnings_gel: რეფერერის მიერ სულ გამომუშავებული ბონუსი
      // (frontend-ის პროფილის სტატისტიკისთვის — "გამომუშავებული ბონუსი").
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS has_triggered_first_deposit_reward  BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS has_triggered_first_purchase_reward BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_earnings_gel NUMERIC(12,2) NOT NULL DEFAULT 0.00`,
      // ინდექსი — "ვინ მოიწვია ვინ" საპირისპირო ძებნისთვის (COUNT(*) WHERE
      // referred_by=$1 — გამოიყენება პროფილში "მოწვეული მეგობრები" სტატისტიკაზე).
      `CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)`,
      // ── REFERRAL v2 — მოკლე, წაკითხვადი პრომო-კოდები (`REF-XXXXXX`),
      // ძველი UUID-ბმულის ნაცვლად (იხ. src/utils/referral.js). თითო
      // მომხმარებელს ერთი უნიკალური კოდი აქვს — გენერირდება
      // რეგისტრაციისას (auth.js) ან lazy, პირველივე GET /auth/me-ზე
      // ძველი ანგარიშებისთვის. UNIQUE constraint მრავალ NULL-საც
      // უშვებს (მიგრაციამდელი მწკრივები დროებით NULL-ით დარჩება,
      // სანამ ის მომხმარებელი ხელახლა არ შემოვა), მაგრამ ორ
      // არა-NULL მნიშვნელობას შორის კოლიზიას კრძალავს.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(30) UNIQUE`,
      `CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`,
      // ── WALLET UX FIX — ადმინის დეტალური შენიშვნა (დეპოზიტის/გამოტანის
      // დამტკიცება ან უარყოფა) აღარ ერწყმის transactions.description-ს
      // (ეს ველი პირდაპირ ჩანდა საფულის ტრანზაქციების ისტორიაში და
      // არაპროფესიონალურად გამოიყურებოდა). ახლა შენახულია ცალკე
      // admin_note სვეტში — შიდა/support არქივისთვის; UI-ში აღარ ჩანს,
      // მომხმარებელს კი სრულად ეგზავნება ელ-ფოსტით (იხ. admin.js + mailer.js).
      `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS admin_note TEXT`,
      // ── SEMI-AUTOMATED DEPOSIT — მომხმარებელი ბანკის გადარიცხვის
      // დამადასტურებელ სქრინშოტს ტვირთავს POST /api/wallet/deposit/:id/
      // screenshot-ზე (wallet.js). ადმინი ამ სურათს ხედავს დეპოზიტების
      // მოთხოვნების სიაში (admin.js GET /deposits, t.* აბრუნებს ამ
      // სვეტსაც) და მხოლოდ ამის შემდეგ იღებს Approve/Reject გადაწყვეტილებას.
      `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS screenshot_url TEXT`,
      // ── CATEGORY MANAGEMENT — დინამიური კატეგორიები ──────────────────
      // ძველად listings.js-ში VALID_CATEGORIES მუდმივი მასივი იყო
      // hardcoded (mobile/pc/social/boosting/currency/apps) — ახლა ეს
      // ცხრილი ხდება ერთადერთი წყარო (Single Source of Truth), ადმინს
      // შეუძლია დინამიურად დაამატოს/ჩართოს/გამორთოს/წაშალოს კატეგორია
      // Watchtower-იდან (იხ. admin.js /categories). seed-ით ივსება
      // ზუსტად ძველი 6 კატეგორია, რომ არსებული განცხადებები/ვალიდაცია
      // მიგრაციის შემდეგ არ დაზიანდეს.
      `CREATE TABLE IF NOT EXISTS categories (
        id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
        slug        VARCHAR(30)  NOT NULL UNIQUE,
        name_ka     VARCHAR(60)  NOT NULL,
        icon        VARCHAR(10),
        sort_order  INT          NOT NULL DEFAULT 0,
        is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_categories_active ON categories(is_active, sort_order)`,
      `INSERT INTO categories (slug, name_ka, icon, sort_order) VALUES
         ('mobile','მობილური','📱',1),
         ('pc','კომპიუტერი','🖥️',2),
         ('social','სოც. ქსელი','👥',3),
         ('boosting','ბუსტინგი','🚀',4),
         ('currency','ვალუტა','💰',5),
         ('apps','აპლიკაციები','📦',6)
       ON CONFLICT (slug) DO NOTHING`,
      // ── GLOBAL ANNOUNCEMENTS — საიტის მასშტაბით გამოცხადებები ─────────
      // ადმინი ქმნის announcement-ს Watchtower-იდან (admin.js /announcements) —
      // ინახება აქ persist-banner-ისთვის (GET /api/stats/announcements,
      // საჯარო, no-cache) და ერთდროულად push-ით ეგზავნება ყველა
      // მომხმარებელს ვისაც push subscription აქვს რეგისტრირებული.
      `CREATE TABLE IF NOT EXISTS announcements (
        id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
        title       VARCHAR(200) NOT NULL,
        body        TEXT         NOT NULL,
        level       VARCHAR(20)  NOT NULL DEFAULT 'info',
        is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
        created_by  UUID         REFERENCES users(id),
        expires_at  TIMESTAMPTZ,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, created_at DESC)`,
      // ── ANTI-SCAM SUITE ──────────────────────────────────────────────
      // 1) Video Proof — მყიდველი ვალდებულია ყიდვის მომენტში დაეთანხმოს
      //    სქრინ-ჩაწერის პირობას; ეს დათანხმება ერთხელ და
      //    შეუქცევადად ფიქსირდება order-ზე (client-side checkbox მარტო
      //    საკმარისი არაა — თუ ბექენდზე არ არის დაფიქს., API-ის
      //    პირდაპირი გამოძახებით შეიძლებოდა გვერდის ავლა).
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS video_proof_agreed BOOLEAN NOT NULL DEFAULT FALSE`,
      // 2) Credentials Vault — გამყიდველი ანგარიშის email+პაროლს
      //    სავალდებულოდ ცალკე, დაშიფრული ("iv:tag:ciphertext") ფორმით
      //    წარადგენს (არა ჩვეულ chat-ში პირდაპირ ტექსტში), რომ ზუსტად
      //    გავზომოთ ორი დროის წერტილი: (ა) როდის გაუზიარა გამყ-მა
      //    მონაცემი და (ბ) ზუსტად რომელ წამს გახსნა/ნახა მყიდველმა.
      //    ეს ორი timestamp-ი შემდეგ ადმინის მიერ დავის დროს შედარდება
      //    გარე მტკიცებულებას (მაგ. როდის შეიცვალა პაროლი ბაზაში/
      //    გუგლის აქტ. ისტორიაში) — თუ ცვლილება მოხდა ნახვის შემდეგ,
      //    ეს მყიდველის მხრიდან ბოროტ განზრახვაზე მეტყველებს.
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS credentials_secret        TEXT`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS credentials_submitted_at TIMESTAMPTZ`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS credentials_viewed_at    TIMESTAMPTZ`,
      // 3) Clean Email Policy — გამყიდველი განცხადების შექმნისას
      //    ადასტურებს, რომ ანგარიშზე მიბმული email "სუფთაა" (ახალი,
      //    არა პირადი) და მასზეც წვდომას აწვდის მყიდველს — ეს
      //    ხელს უშლის სცენარს, როცა მყიდველი აცხადებს პაროლის
      //    შეცვლას, სინამდვილეში კი უბრალოდ ვერ შედის, რადგან
      //    "დაბრუნების" email საერთოდ არ გადაცემულა.
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS clean_email_confirmed BOOLEAN NOT NULL DEFAULT FALSE`,
    ];
    for (const sql of migrations) {
      try { await client.query(sql); } catch (e) { /* უკვე არსებობს */ }
    }
    console.log('✅ Migrations გამოყენებულია');

    // ── REFERRAL v2 backfill — migration-მდე შექმნილ მომხმარებლებს
    // (referral_code IS NULL) თითო-თითოდ ვუნიჭებთ ახალ პრომო-კოდს.
    // GET /auth/me-შიც ხდება იგივე lazy-backfill ცალკეული user-ისთვის
    // (auth.js), მაგრამ აქ ერთბაშად ვასუფთავებთ ყველა ძველ ჩანაწერს,
    // რომ არც ერთ მომხმარებელს არ მოუწიოს ლოგინამდე კოდის გარეშე ყოფნა.
    try {
      const { rows: missingCode } = await client.query(
        'SELECT id, username FROM users WHERE referral_code IS NULL'
      );
      if (missingCode.length) {
        for (const u of missingCode) {
          try {
            await referral.ensureReferralCode(client, u.id, u.username);
          } catch (e) {
            console.error(`⚠️  referral_code backfill ვერ მოხერხდა user ${u.id}-სთვის:`, e.message);
          }
        }
        console.log(`✅ Referral კოდები დაბრუნდა ${missingCode.length} ძველ მომხმარებელს`);
      }
    } catch (e) {
      console.error('⚠️  referral_code backfill query ჩავარდა:', e.message);
    }

    // Admin user (პირველი გაშვებისას) — OTP სისტემაზე გადასვლის შემდეგ
    // პაროლი აღარ სჭირდება, admin@gamerbazar.ge-ზე შესვლა ხდება Email+OTP-ით
    const existing = await client.query(
      "SELECT id FROM users WHERE email = 'admin@gamerbazar.ge'"
    );
    if (existing.rowCount === 0) {
      await client.query(`
        INSERT INTO users
          (email, username, display_name, bio, auth_provider,
           role, is_verified_seller, email_verified)
        VALUES
          ('admin@gamerbazar.ge','admin','GamerBazar Admin',
           'პლატფორმის ადმინი','email','admin',TRUE,TRUE)
      `);
      console.log('✅ Admin user შეიქმნა');
      console.log('   Email: admin@gamerbazar.ge');
      console.log('   შესვლა: Email + OTP კოდით (გაიგზავნება მითითებულ SMTP/EMAIL_USER საფოსტო ყუთზე)');
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
if (require.main === module) {
  setupDatabase();
}
module.exports = { setupDatabase };
