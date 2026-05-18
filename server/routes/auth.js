import { Router }   from 'express'
import bcrypt        from 'bcryptjs'
import jwt           from 'jsonwebtoken'
import { pool }      from '../db/index.js'

const router = Router()

function sign(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' })
}

// POST /api/auth/login  — school staff login (school_admin, bursar, accountant)
router.post('/login', async (req, res, next) => {
  try {
    const { slug, email, password } = req.body
    if (!slug || !email || !password)
      return res.status(400).json({ error: 'slug, email and password are required' })

    const schoolRes = await pool.query(
      'SELECT id, name, slug, type FROM schools WHERE slug = $1 AND active = true',
      [slug]
    )
    if (!schoolRes.rows.length)
      return res.status(404).json({ error: 'School not found' })

    const school = schoolRes.rows[0]

    const userRes = await pool.query(
      'SELECT * FROM users WHERE school_id = $1 AND email = $2 AND active = true',
      [school.id, email]
    )
    if (!userRes.rows.length)
      return res.status(401).json({ error: 'Invalid credentials' })

    const user = userRes.rows[0]
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

    const token = sign({
      id:        user.id,
      school_id: user.school_id,
      role:      user.role,
      name:      user.name,
      email:     user.email,
      school:    { id: school.id, name: school.name, slug: school.slug, type: school.type },
    })

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role }, school })
  } catch (err) { next(err) }
})

// POST /api/auth/super-login  — platform super admin login
router.post('/super-login', async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password)
      return res.status(400).json({ error: 'email and password are required' })

    const { rows } = await pool.query(
      'SELECT * FROM super_admins WHERE email = $1',
      [email]
    )
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' })

    const valid = await bcrypt.compare(password, rows[0].password_hash)
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

    const sa    = rows[0]
    const token = sign({ id: sa.id, role: 'super_admin', name: sa.name, email: sa.email })

    res.json({ token, user: { id: sa.id, name: sa.name, email: sa.email, role: 'super_admin' } })
  } catch (err) { next(err) }
})

// POST /api/auth/hash  — helper to generate a bcrypt hash (dev only)
if (process.env.NODE_ENV !== 'production') {
  router.post('/hash', async (req, res) => {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'password required' })
    const hash = await bcrypt.hash(password, 10)
    res.json({ hash })
  })
}

export default router
