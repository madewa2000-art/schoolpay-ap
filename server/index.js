import express  from 'express'
import cors     from 'cors'
import helmet   from 'helmet'
import dotenv   from 'dotenv'
import path     from 'path'
import fs       from 'fs'
import { fileURLToPath } from 'url'

import rateLimit   from 'express-rate-limit'
import authRoutes       from './routes/auth.js'
import schoolRoutes     from './routes/schools.js'
import paymentRoutes    from './routes/payments.js'
import documentRoutes   from './routes/documents.js'
import receiptRoutes    from './routes/receipts.js'
import complaintRoutes  from './routes/complaints.js'
import webhookRoutes    from './routes/webhooks.js'

dotenv.config()

// ─── Startup safety guards ────────────────────────────────────────────────────
if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) {
  console.error('FATAL: No database configured. Set DATABASE_URL (production/Railway) or DB_PASSWORD (local dev) in .env')
  process.exit(1)
}
const DEV_JWT = 'dev-secret-change-in-production-schoolpay-2026'
if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET === DEV_JWT) {
  console.error('FATAL: JWT_SECRET is still the default dev value. Set a strong secret before running in production.')
  process.exit(1)
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters long.')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 4000
const isProd = process.env.NODE_ENV === 'production'

// ─── Security headers (helmet + CSP) ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      // 'unsafe-inline' is required because the HTML pages use inline <script> tags.
      // External scripts: Paystack popup + jsPDF from CDN.
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://js.paystack.co', 'https://cdnjs.cloudflare.com'],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", 'data:', 'https://res.cloudinary.com'],
      // Paystack popup opens as an iframe from checkout.paystack.com
      frameSrc:       ['https://checkout.paystack.com'],
      frameAncestors: ["'none'"],
      connectSrc:     ["'self'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}))

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Restrict to the frontend origin. In dev this is the same server; in prod it's
// the deployed frontend domain set via CLIENT_URL.
const allowedOrigin = process.env.CLIENT_URL || 'http://localhost:4000'
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (origin is undefined when browser requests
    // same-origin, e.g. from express.static) and the configured frontend URL.
    if (!origin || origin === allowedOrigin) return cb(null, true)
    cb(new Error(`CORS: origin ${origin} not allowed`))
  },
  credentials: false,
}))

// ─── Body parsing ─────────────────────────────────────────────────────────────
// Raw body needed for Paystack webhook HMAC verification
app.use('/api/webhooks', express.raw({ type: 'application/json' }))
// Explicit 100 kb cap for JSON — prevents oversized payload attacks
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: false, limit: '100kb' }))

// ─── Static client files ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'client')))

// ─── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
})

// Payment initiation: 5 attempts per 10 minutes per IP — prevents fake-record spam
const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts from this device. Please wait 10 minutes.' },
})

// General API: 200 requests per minute per IP — catches scrapers and DoS
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
})

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api',                    apiLimiter)
app.use('/api/auth',               authLimiter,    authRoutes)
app.use('/api/schools',            schoolRoutes)
app.use('/api/s/:slug/payments/initiate', paymentLimiter)
app.use('/api/s/:slug',            paymentRoutes)
app.use('/api/s/:slug',            documentRoutes)
app.use('/api/s/:slug',            receiptRoutes)
app.use('/api/s/:slug',            complaintRoutes)
app.use('/api/webhooks',           webhookRoutes)

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  // Never log to stdout in silence — always record the full error server-side
  console.error(err)
  const status = err.status || 500
  // In production expose only a generic message so attackers can't read stack
  // traces or internal details. In dev, include the real message for debugging.
  const message = isProd && status === 500
    ? 'Internal server error'
    : (err.message || 'Internal server error')
  res.status(status).json({ error: message })
})

async function runMigrations() {
  const { pool } = await import('./db/index.js')
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8')
  await pool.query(sql)
  console.log('Database schema ready')
}

app.listen(PORT, () => {
  ;(async () => {
    try {
      await runMigrations()
      console.log(`SchoolPay server running on port ${PORT}`)
    } catch (err) {
      console.error('FATAL: Startup failed:', err.message)
      process.exit(1)
    }
  })()
})
