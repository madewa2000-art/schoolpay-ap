import pg      from 'pg'
import dotenv  from 'dotenv'
dotenv.config()

const { Pool } = pg

// ─── Real PostgreSQL ──────────────────────────────────────────────────────────
function realPool() {
  // DATABASE_URL takes priority (Railway, Render, any managed host)
  const config = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME     || 'schoolpay',
        user:     process.env.DB_USER     || 'postgres',
        password: process.env.DB_PASSWORD,
      }
  const pool = new Pool(config)
  pool.on('error', (err) => console.error('DB pool error', err))
  return pool
}

// ─── In-memory (pg-mem) ───────────────────────────────────────────────────────
async function memPool() {
  const { newDb }         = await import('pg-mem')
  const fs                = await import('fs')
  const path              = await import('path')
  const { fileURLToPath } = await import('url')
  const __dirname = path.dirname(fileURLToPath(import.meta.url))

  const db = newDb()

  // Load the simplified pg-mem compatible schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema-mem.sql'), 'utf8')
  const stmts  = schema.split(';').map(s => s.trim()).filter(Boolean)
  for (const stmt of stmts) {
    try { db.public.none(stmt) } catch { /* skip */ }
  }

  // Seed default super admin (password: "P@ssw0rd")
  const bcrypt = await import('bcryptjs')
  const hash   = await bcrypt.hash('P@ssw0rd', 10)
  const saId   = newUUID()
  try {
    db.public.none(
      `INSERT INTO super_admins (id, name, email, password_hash) VALUES ('${saId}', 'Platform Admin', 'admin@schoolpay.local', '${hash}')`
    )
  } catch { /* already exists */ }

  const adapter = db.adapters.createPg()
  const pool    = new adapter.Pool()

  // Patch query to auto-generate UUIDs for placeholder defaults
  const origQuery = pool.query.bind(pool)
  pool.query = function (text, params) {
    if (typeof text === 'string') {
      // Replace gen_random_uuid() calls with actual UUIDs
      const fixed = text.replace(/gen_random_uuid\(\)/gi, `'${newUUID()}'`)
      return origQuery(fixed, params)
    }
    return origQuery(text, params)
  }

  console.log('\n🗄  Running with IN-MEMORY database (pg-mem).')
  console.log('   Data resets on restart. To persist: install PostgreSQL & set DB_PASSWORD in .env\n')
  return pool
}

function newUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ─── Lazy pool — resolved once, reused everywhere ────────────────────────────
let _pool = null

async function getPool() {
  if (_pool) return _pool
  _pool = (process.env.DATABASE_URL || process.env.DB_PASSWORD) ? realPool() : await memPool()
  return _pool
}

// Transparent proxy: pool.query(...) / pool.connect() work without changes
export const pool = new Proxy({}, {
  get(_, prop) {
    return async (...args) => {
      const p = await getPool()
      return p[prop](...args)
    }
  },
})
