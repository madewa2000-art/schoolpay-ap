import { Router }  from 'express'
import bcrypt       from 'bcryptjs'
import { pool }     from '../db/index.js'
import { verifyToken, requireRole } from '../middleware/auth.js'

const router = Router()
const superOnly = [verifyToken, requireRole('super_admin')]

// GET /api/schools — list all schools
router.get('/', ...superOnly, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, type, logo_url, bank_name, bank_account, active, created_at
       FROM schools ORDER BY created_at DESC`
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/schools/:id/stats — per-school payment stats
router.get('/:id/stats', ...superOnly, async (req, res, next) => {
  try {
    const { id } = req.params
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                              AS total_payments,
        COUNT(*) FILTER (WHERE status = 'confirmed')         AS confirmed,
        COUNT(*) FILTER (WHERE status = 'pending')           AS pending,
        COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0) AS total_collected
      FROM payments WHERE school_id = $1
    `, [id])
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/schools — onboard a new school
router.post('/', ...superOnly, async (req, res, next) => {
  try {
    const {
      name, slug, type,
      logo_url, bank_name, bank_account, bank_account_name,
      paystack_public_key, paystack_secret_key,
      from_email, smtp_host, smtp_port, smtp_user, smtp_pass,
      // first admin user
      admin_name, admin_email, admin_password,
    } = req.body

    if (!name || !slug || !type || !admin_name || !admin_email || !admin_password)
      return res.status(400).json({ error: 'name, slug, type and admin details are required' })

    if (!['primary','secondary','university'].includes(type))
      return res.status(400).json({ error: 'type must be primary, secondary, or university' })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const schoolRes = await client.query(
        `INSERT INTO schools
           (name, slug, type, logo_url, bank_name, bank_account, bank_account_name,
            paystack_public_key, paystack_secret_key,
            from_email, smtp_host, smtp_port, smtp_user, smtp_pass)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id, name, slug, type`,
        [name, slug, type, logo_url, bank_name, bank_account, bank_account_name,
         paystack_public_key, paystack_secret_key,
         from_email, smtp_host, smtp_port || 587, smtp_user, smtp_pass]
      )
      const school = schoolRes.rows[0]

      const hash = await bcrypt.hash(admin_password, 10)
      await client.query(
        `INSERT INTO users (school_id, name, email, role, password_hash)
         VALUES ($1,$2,$3,'school_admin',$4)`,
        [school.id, admin_name, admin_email, hash]
      )

      // Seed default fee types based on school type
      const defaults = {
        primary:    ['Tuition', 'PTA Levy', 'Uniform Fee', 'Exam Fee'],
        secondary:  ['School Fees', 'Exam Levy', 'Development Levy', 'Lab Fee', 'Boarding Fee'],
        university: ['Tuition', 'Acceptance Fee', 'Hostel Fee', 'Library Fee', 'Faculty Dues', 'Examination Fee'],
      }[type]

      for (const name of defaults) {
        await client.query(
          `INSERT INTO payment_types (school_id, name, amount, is_mandatory)
           VALUES ($1, $2, 0, true)`,
          [school.id, name]
        )
      }

      await client.query('COMMIT')
      res.status(201).json({ school, message: 'School onboarded successfully' })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Slug already taken' })
    next(err)
  }
})

// PATCH /api/schools/:id — update school settings
router.patch('/:id', ...superOnly, async (req, res, next) => {
  try {
    const allowed = [
      'name','logo_url','bank_name','bank_account','bank_account_name',
      'paystack_public_key','paystack_secret_key',
      'from_email','smtp_host','smtp_port','smtp_user','smtp_pass','active'
    ]
    const fields  = Object.keys(req.body).filter(k => allowed.includes(k))
    if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' })

    const sets  = fields.map((f, i) => `${f} = $${i + 2}`).join(', ')
    const vals  = fields.map(f => req.body[f])
    const { rows } = await pool.query(
      `UPDATE schools SET ${sets} WHERE id = $1 RETURNING id, name, slug, type, active`,
      [req.params.id, ...vals]
    )
    if (!rows.length) return res.status(404).json({ error: 'School not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/schools/:id/suspend — soft suspend (set active=false)
router.patch('/:id/suspend', ...superOnly, async (req, res, next) => {
  try {
    await pool.query('UPDATE schools SET active = false WHERE id = $1', [req.params.id])
    res.json({ message: 'School suspended' })
  } catch (err) { next(err) }
})

export default router
