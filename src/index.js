// src/index.js  — GamerBazar.ge Backend სერვერი
'use strict';

require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');
const http         = require('http');
const rateLimit    = require('express-rate-limit');

const db              = require('./db');
const mailer          = require('./utils/mailer');       // ← ახალი
const push            = require('./utils/push');          // ← ახალი
const authRoutes      = require('./routes/auth');
const listingRoutes   = require('./routes/listings');
const orderRoutes     = require('./routes/orders');
const walletRoutes    = require('./routes/wallet');
const chatRoutes      = require('./routes/chat');
const { setupWebSocket } = require('./routes/chat');
const reviewRoutes    = require('./routes/reviews');
const disputeRoutes   = require('./routes/disputes');
const userRoutes      = require('./routes/users');
const statsRoutes     = require('./routes/stats');       // ← ახალი
const pushRoutes      = require('./routes/push');        // ← ახალი
const adminRoutes     = require('./routes/admin');       // ← ახალი

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 4000;

// Render-ი reverse proxy-ს უკან დგას — ეს საჭიროა, რომ
// express-rate-limit-მა client-ის რეალური IP ნახოს (არა Render-ის proxy IP)
app.set('trust proxy', 1);

// ── Middleware ────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Static (ავატ. / listing სურ.) ───────────────────────────
const uploadDir = process.env.UPLOAD_DIR || './uploads';
app.use('/uploads', express.static(path.resolve(uploadDir)));

// ── Static (frontend HTML, admin.html, sw.js) ───────────────
// აქ root-ში ვემსახურებით frontend ფაილებს (იგივე service, იგივე URL)
app.use(express.static(path.resolve(__dirname, '..'), { index: false }));

// ── Root → მთავარი frontend გვერდი ───────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'gamer-market-ge.html'));
});

// ── Rate Limiting — brute-force დაცვა auth endpoint-ებზე ───────
// login: მაქს. 8 მცდელობა 15 წუთში თითო IP-დან
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'ბევრი მცდელობა — სცადე 15 წუთში' },
});

// register: მაქს. 10 ახალი ანგარიში საათში თითო IP-დან
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'ბევრი რეგისტრაცია — სცადე მოგვიანებით' },
});

app.use('/api/auth/login',    loginLimiter);
app.use('/api/auth/register', registerLimiter);

// ── Routes ───────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/orders',   orderRoutes);
app.use('/api/wallet',   walletRoutes);
app.use('/api/chat',     chatRoutes);
app.use('/api/reviews',  reviewRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/stats',    statsRoutes);                  // ← ახალი
app.use('/api/push',     pushRoutes);                   // ← ახალი
app.use('/api/admin',    adminRoutes);                  // ← ახალი

// ── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app:    'GamerBazar.ge API',
    env:    process.env.NODE_ENV,
    time:   new Date().toISOString(),
  });
});

// ── API Endpoints სია (dev-ში) ────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.get('/api', (req, res) => {
    res.json({
      endpoints: [
        'POST   /api/auth/register',
        'POST   /api/auth/login',
        'GET    /api/auth/google',
        'GET    /api/auth/google/callback',
        'GET    /api/auth/me',
        'PUT    /api/auth/me',
        'GET    /api/listings?category=&game=&seller_id=&search=&sort=&page=',
        'GET    /api/listings/:id',
        'POST   /api/listings',
        'PUT    /api/listings/:id',
        'DELETE /api/listings/:id',
        'POST   /api/listings/:id/vip',
        'POST   /api/orders',
        'GET    /api/orders/me',
        'GET    /api/orders/history',
        'GET    /api/orders/:id',
        'POST   /api/orders/:id/deliver',
        'POST   /api/orders/:id/confirm',
        'POST   /api/orders/:id/cancel',
        'GET    /api/wallet/balance',
        'GET    /api/wallet/transactions',
        'POST   /api/wallet/deposit',
        'POST   /api/wallet/withdraw',
        'GET    /api/wallet/deposit/simulate (dev only)',
        'GET    /api/chat/rooms',
        'GET    /api/chat/rooms/:id/messages',
        'POST   /api/chat/rooms/:id/messages',
        'WS     /ws/chat?token=JWT&room=ROOM_ID',
        'POST   /api/reviews',
        'GET    /api/reviews/seller/:id',
        'POST   /api/disputes',
        'GET    /api/disputes/:id',
        'PUT    /api/disputes/:id/resolve  (admin)',
        'GET    /api/users/:id',
        'POST   /api/users/me/avatar',
        'GET    /api/stats',                            // ← ახალი
        'POST   /api/listings/:id/images (multipart)',  // ← ახალი
        'GET    /api/push/vapid-key',                   // ← ახალი
        'POST   /api/push/subscribe',                   // ← ახალი
        'POST   /api/push/unsubscribe',                 // ← ახალი
        'GET    /api/admin/disputes',                   // ← ახალი
        'PUT    /api/admin/disputes/:id/resolve',       // ← ახალი
        'GET    /api/admin/users',                      // ← ახალი
        'PUT    /api/admin/users/:id/ban',              // ← ახალი
        'PUT    /api/admin/users/:id/unban',            // ← ახალი
        'GET    /api/admin/listings',                   // ← ახალი
        'PUT    /api/admin/listings/:id/moderate',      // ← ახალი
        'DELETE /api/admin/listings/:id',               // ← ახალი
        'GET    /api/admin/overview',                   // ← ახალი
      ]
    });
  });
}

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// ── Error Handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'server_error', message: err.message });
});

// ── WebSocket ─────────────────────────────────────────────────
setupWebSocket(server);

// ══════════════════════════════════════════════════════════════
// ⏰ CRON — Order-ების ავტო-გაუქმება (48სთ deadline)
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// ⏰ CRON 1 — „Delivered" შეკვეთების ავტო-დასრულება
// status='delivered' + confirm_deadline < NOW() → completed
// გამყიდველს ფული ჩაირიცხება + 24სთ hold
// ══════════════════════════════════════════════════════════════
async function expireDelivered() {
  try {
    const { rows } = await db.query(`
      SELECT o.id, o.buyer_id, o.seller_id, o.listing_id,
             o.amount_gel, o.seller_receives, o.escrow_status,
             l.title AS listing_title
      FROM orders o
      JOIN listings l ON l.id = o.listing_id
      WHERE o.status = 'delivered'
        AND o.escrow_status = 'held'
        AND o.confirm_deadline IS NOT NULL
        AND o.confirm_deadline < NOW()
    `);

    if (!rows.length) return;
    console.log(`📦 Auto-completing ${rows.length} delivered order(s)...`);

    for (const order of rows) {
      try {
        await db.transaction(async (client) => {
          // buyer-ის escrow_hold გათავისუფლება
          await client.query(
            'UPDATE users SET escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
            [order.amount_gel, order.buyer_id]
          );
          // გამყიდველს ბალანსი + 24სთ hold
          await client.query(`
            UPDATE users SET
              balance_gel          = balance_gel + $1,
              balance_available_at = GREATEST(
                COALESCE(balance_available_at, NOW()),
                NOW() + INTERVAL '24 hours'
              )
            WHERE id = $2
          `, [order.seller_receives, order.seller_id]);

          await client.query(`
            UPDATE orders SET
              status        = 'completed',
              escrow_status = 'released',
              buyer_confirmed = FALSE,
              completed_at  = NOW(),
              updated_at    = NOW()
            WHERE id = $1
          `, [order.id]);

          await client.query(
            "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'sale_income',$3,'ავტო-დასრ.: 48სთ ტაიმერი')",
            [order.seller_id, order.id, order.seller_receives]
          );
          await client.query(
            "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'platform_fee',$3,'პლატფ. კომ.')",
            [order.seller_id, order.id, -(order.amount_gel - order.seller_receives)]
          );
          await client.query("UPDATE listings SET status='sold' WHERE id=$1", [order.listing_id]);
        });

        console.log(`  ✅ Order ${order.id} auto-completed → seller +₾${order.seller_receives} (24h hold)`);

        try {
          const listing = { title: order.listing_title };
          const { rows: sellerRows } = await db.query('SELECT id, email, notif_email FROM users WHERE id=$1', [order.seller_id]);
          const { rows: buyerRows }  = await db.query('SELECT id, email, notif_email FROM users WHERE id=$1', [order.buyer_id]);

          // Chat-ში სისტ. შეტყობ.
          const { rows: roomRows } = await db.query('SELECT id FROM chat_rooms WHERE order_id=$1', [order.id]);
          if (roomRows.length) {
            await db.query(`
              INSERT INTO messages(room_id, sender_id, content, content_type)
              VALUES($1, $2, '✅ 48-საათიანი ვადა გავიდა — შეკვეთა ავტომატურად დასრულდა. ფული გამყიდველს გადაეცა.', 'system')
            `, [roomRows[0].id, order.seller_id]);
          }

          if (sellerRows.length) await mailer.sendOrderConfirmedEmail(sellerRows[0], order, listing);
          await push.sendToUser(order.seller_id, {
            title: '✅ ავტო-დასტური',
            body: `${listing.title} — ₾${Number(order.seller_receives).toFixed(2)} ბალანსზე (24სთ hold)`,
            url: `/?page=wallet`, tag: `order-${order.id}-auto-completed`,
          });
          if (buyerRows.length) await mailer.sendOrderExpiredEmail(buyerRows[0], order, listing);
          await push.sendToUser(order.buyer_id, {
            title: '⏰ ავტო-დასტური',
            body: `${listing.title} — 48სთ ვადა გავიდა, შეკვ. დასრულდა`,
            url: `/?order=${order.id}`, tag: `order-${order.id}-auto-buyer`,
          });
        } catch (e) { console.error(`  ⚠️ auto-complete notify failed:`, e.message); }
      } catch (e) {
        console.error(`  ❌ auto-complete failed for ${order.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('expireDelivered error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// ⏰ CRON 2 — 24სთ შეხსენება (მყიდველს ჩატში + email + push)
// გაიშვება: delivered_at + 24სთ < NOW() AND reminder_24h_sent=FALSE
// ══════════════════════════════════════════════════════════════
async function send24hReminders() {
  try {
    const { rows } = await db.query(`
      SELECT o.id, o.buyer_id, o.seller_id, o.listing_id,
             o.amount_gel, o.confirm_deadline, l.title AS listing_title
      FROM orders o
      JOIN listings l ON l.id = o.listing_id
      WHERE o.status = 'delivered'
        AND o.reminder_24h_sent = FALSE
        AND o.delivered_at IS NOT NULL
        AND o.delivered_at + INTERVAL '24 hours' < NOW()
        AND o.confirm_deadline > NOW()
    `);

    if (!rows.length) return;
    console.log(`⏰ Sending 24h reminders for ${rows.length} order(s)...`);

    for (const order of rows) {
      try {
        const listing = { title: order.listing_title };

        // ჩატში სისტ. შეტყობ.
        const { rows: roomRows } = await db.query('SELECT id FROM chat_rooms WHERE order_id=$1', [order.id]);
        if (roomRows.length) {
          await db.query(`
            INSERT INTO messages(room_id, sender_id, content, content_type)
            VALUES($1, $2, '⏰ შეახსენება: დარჩა 24 საათი! დაადასტ. მიღება ან გახსენი დავა, წინ. შემთხ. ფული ავტომ. გამყ-ს გადაეცემა.', 'system')
          `, [roomRows[0].id, order.seller_id]);
        }

        const { rows: buyerRows } = await db.query('SELECT id, email, notif_email FROM users WHERE id=$1', [order.buyer_id]);
        if (buyerRows.length) await mailer.send24hReminderEmail(buyerRows[0], order, listing);
        await push.sendToUser(order.buyer_id, {
          title: '⏰ 24 საათი დარჩა',
          body: `${listing.title} — დაადასტ. ან გახსენი დავა`,
          url: `/?order=${order.id}`, tag: `order-${order.id}-reminder`,
        });

        // flag → TRUE
        await db.query('UPDATE orders SET reminder_24h_sent=TRUE, updated_at=NOW() WHERE id=$1', [order.id]);
        console.log(`  ✅ Reminder sent for ${order.id}`);
      } catch (e) {
        console.error(`  ⚠️ reminder failed for ${order.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('send24hReminders error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// ⏰ CRON 3 — Legacy: „active" შეკვეთები (გამყ. ჯერ არ მიუწვდენია)
// active + escrow=held + deadline < NOW() → გაუქმება + refund მყიდველს
// (ეს ხდება მაშინ, როცა deliver-ი საერთოდ არ მომხდარა)
// ══════════════════════════════════════════════════════════════
async function expireOrders() {
  try {
    const { rows } = await db.query(`
      SELECT o.id, o.buyer_id, o.listing_id, o.amount_gel, o.escrow_status, l.title AS listing_title
      FROM orders o
      JOIN listings l ON l.id = o.listing_id
      WHERE o.status = 'active'
        AND o.escrow_status = 'held'
        AND o.created_at + INTERVAL '5 days' < NOW()
    `);

    if (!rows.length) return;
    console.log(`↩️ Expiring ${rows.length} stale active order(s)...`);

    for (const order of rows) {
      try {
        await db.transaction(async (client) => {
          if (order.escrow_status === 'held') {
            await client.query(
              'UPDATE users SET balance_gel=balance_gel+$1, escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
              [order.amount_gel, order.buyer_id]
            );
            await client.query(
              "INSERT INTO transactions(user_id,order_id,type,amount_gel,description) VALUES($1,$2,'escrow_refund',$3,'ავტო-გაუქმება: გამყ. 5 დღეში ვერ მიაწვდინა')",
              [order.buyer_id, order.id, order.amount_gel]
            );
          }
          await client.query(`
            UPDATE orders SET
              status        = 'cancelled',
              escrow_status = 'refunded',
              cancelled_at  = NOW(),
              cancel_reason = 'ავტომ. გაუქმება — გამყ. 5 დღეში ვერ მიაწვდინა',
              updated_at    = NOW()
            WHERE id = $1
          `, [order.id]);
          await client.query("UPDATE listings SET status='active' WHERE id=$1", [order.listing_id]);
        });

        console.log(`  ✅ Stale order ${order.id} refunded ₾${order.amount_gel}`);

        try {
          const { rows: buyerRows } = await db.query('SELECT id, email, notif_email FROM users WHERE id=$1', [order.buyer_id]);
          const listing = { title: order.listing_title };
          if (buyerRows.length) await mailer.sendOrderExpiredEmail(buyerRows[0], order, listing);
          await push.sendToUser(order.buyer_id, {
            title: '↩️ შეკვ. გაუქმდა',
            body: `${listing.title} — გამყ. ვერ მიაწვდინა, ₾${Number(order.amount_gel).toFixed(2)} დაბრ.`,
            url: `/?page=wallet`, tag: `order-${order.id}-expired`,
          });
        } catch (e) { console.error(`  ⚠️ notify failed:`, e.message); }
      } catch (e) {
        console.error(`  ❌ expire failed for ${order.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('expireOrders error:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────
async function start() {
  console.log('\n🎮 GamerBazar.ge Backend\n');

  const dbOk = await db.testConnection();
  if (!dbOk) {
    console.error('❌ DB-ს გარეშე სერვერი ვერ გაეშვება.');
    console.error('   შეამოწმე .env-ში DATABASE_URL');
    process.exit(1);
  }

  try {
    const { setupDatabase } = require('./db/setup');
    await setupDatabase();
  } catch(e) {
    console.log('ℹ️  DB setup:', e.message);
  }

  server.listen(PORT, () => {
    console.log(`\n✅ API:       http://localhost:${PORT}/api`);
    console.log(`✅ Health:    http://localhost:${PORT}/health`);
    console.log(`✅ Stats:     http://localhost:${PORT}/api/stats`);
    console.log(`✅ WebSocket: ws://localhost:${PORT}/ws/chat`);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`\n📋 Endpoints: http://localhost:${PORT}/api`);
      console.log(`🧪 Deposit:   http://localhost:${PORT}/api/wallet/deposit/simulate`);
    }
    console.log('\n👉 Frontend: gamer-market-ge.html\n');

    // ── Cron-ები ─────────────────────────────────────────────
    // 1. Delivered → auto-complete (48სთ ვადა)
    expireDelivered();
    setInterval(expireDelivered, 10 * 60 * 1000); // ყოველ 10 წუთში
    // 2. 24სთ reminder (delivered-ის 24სთ შემდეგ)
    send24hReminders();
    setInterval(send24hReminders, 10 * 60 * 1000);
    // 3. Stale active orders (გამყ. 5 დღეში ვერ მიაწვდინა)
    expireOrders();
    setInterval(expireOrders, 30 * 60 * 1000); // ყოველ 30 წუთში
    console.log('⏰ Order crons: expireDelivered + 24hReminder (10წთ), expireOrders (30წთ)');
  });
}

start();
