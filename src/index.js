// src/index.js  — GamerBazar.ge Backend სერვერი
'use strict';

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const cookieParser = require('cookie-parser');
const path       = require('path');
const http       = require('http');

const db              = require('./db');
const authRoutes      = require('./routes/auth');
const listingRoutes   = require('./routes/listings');
const orderRoutes     = require('./routes/orders');
const walletRoutes    = require('./routes/wallet');
const chatRoutes      = require('./routes/chat');
const { setupWebSocket } = require('./routes/chat');
const reviewRoutes    = require('./routes/reviews');
const disputeRoutes   = require('./routes/disputes');
const userRoutes      = require('./routes/users');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 4000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Static (ავატ. სურ.) ──────────────────────────────────────
const uploadDir = process.env.UPLOAD_DIR || './uploads';
app.use('/uploads', express.static(path.resolve(uploadDir)));

// Frontend HTML (production-ში) ──────────────────────────────
// თუ api და frontend ერთ სერვერზეა:
// app.use(express.static(path.join(__dirname, '../../web/dist')));

// ── Routes ───────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/orders',   orderRoutes);
app.use('/api/wallet',   walletRoutes);
app.use('/api/chat',     chatRoutes);
app.use('/api/reviews',  reviewRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/users',    userRoutes);

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
        'GET    /api/listings?category=&game=&search=&sort=&page=',
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

// ── Start ─────────────────────────────────────────────────────
async function start() {
  console.log('\n🎮 GamerBazar.ge Backend\n');

  // DB კავშირი
  const dbOk = await db.testConnection();
  if (!dbOk) {
    console.error('❌ DB-ს გარეშე სერვერი ვერ გაეშვება.');
    console.error('   შეამოწმე .env-ში DATABASE_URL');
    process.exit(1);
  }

  // ცხრილების შექმნა (თუ პირველად ეშვება)
  try {
    const { setupDatabase } = require('./db/setup');
    await setupDatabase();
  } catch(e) {
    console.log('ℹ️  DB setup:', e.message);
  }

  server.listen(PORT, () => {
    console.log(`\n✅ API: http://localhost:${PORT}/api`);
    console.log(`✅ Health: http://localhost:${PORT}/health`);
    console.log(`✅ WebSocket: ws://localhost:${PORT}/ws/chat`);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`\n📋 Endpoints: http://localhost:${PORT}/api`);
      console.log(`🧪 Deposit sim: http://localhost:${PORT}/api/wallet/deposit/simulate`);
    }
    console.log('\n👉 Frontend-ი გახსენი: gamer-market-ge.html');
    console.log(`   FRONTEND_URL=${process.env.FRONTEND_URL || 'http://localhost:3000'}\n`);
  });
}

start();
