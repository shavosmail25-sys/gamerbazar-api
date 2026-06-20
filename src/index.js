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
        'GET    /api/orders/:id',
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
async function expireOrders() {
  try {
    const { rows } = await db.query(`
      SELECT o.id, o.buyer_id, o.listing_id, o.amount_gel, o.escrow_status, l.title AS listing_title
      FROM orders o
      JOIN listings l ON l.id = o.listing_id
      WHERE o.status = 'active'
        AND o.escrow_status = 'held'
        AND o.confirm_deadline IS NOT NULL
        AND o.confirm_deadline < NOW()
    `);

    if (!rows.length) return;

    console.log(`⏰ Expiring ${rows.length} order(s)...`);

    for (const order of rows) {
      try {
        await db.transaction(async (client) => {
          // Escrow დაბრუნება მყიდველს
          if (order.escrow_status === 'held') {
            await client.query(
              'UPDATE users SET balance_gel=balance_gel+$1, escrow_hold_gel=escrow_hold_gel-$1 WHERE id=$2',
              [order.amount_gel, order.buyer_id]
            );
            await client.query(
              `INSERT INTO transactions(user_id, order_id, type, amount_gel, description)
               VALUES($1, $2, 'escrow_refund', $3, 'ავტო-გაუქმება: 48სთ გავიდა')`,
              [order.buyer_id, order.id, order.amount_gel]
            );
          }

          await client.query(`
            UPDATE orders SET
              status       = 'cancelled',
              escrow_status = 'refunded',
              cancelled_at = NOW(),
              cancel_reason = 'ავტომ. გაუქმება — მყიდვ. 48სთ-ში არ დაადასტ.'
            WHERE id = $1
          `, [order.id]);

          // listing → active (ისევ გამოჩნდეს)
          await client.query(
            "UPDATE listings SET status='active' WHERE id=(SELECT listing_id FROM orders WHERE id=$1)",
            [order.id]
          );
        });

        console.log(`  ✅ Order ${order.id} expired + refunded ₾${order.amount_gel}`);

        // შეტყობ. მყიდველს — email + push
        try {
          const { rows: buyerRows } = await db.query(
            'SELECT id, email, notif_email FROM users WHERE id=$1', [order.buyer_id]
          );
          const listing = { title: order.listing_title };
          if (buyerRows.length) {
            await mailer.sendOrderExpiredEmail(buyerRows[0], order, listing);
          }
          await push.sendToUser(order.buyer_id, {
            title: '⏰ შეკვეთის ვადა გავიდა',
            body: `${listing.title} — ₾${Number(order.amount_gel).toFixed(2)} დაბრუნდა`,
            url: `/?page=wallet`,
            tag: `order-${order.id}-expired`,
          });
        } catch (e) { console.error(`  ⚠️ notify failed for ${order.id}:`, e.message); }
      } catch (e) {
        console.error(`  ❌ Order ${order.id} expire failed:`, e.message);
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

    // ── Cron: ყოველ 15 წუთში expired orders-ის შემოწ. ──────
    expireOrders(); // გაშვებისთანავე ერთხელ
    setInterval(expireOrders, 15 * 60 * 1000);
    console.log('⏰ Order expiry cron: ყოველ 15 წუთში');
  });
}

start();
