import { Router }       from 'express'
import { pool }         from '../db/index.js'
import { attachSchool } from '../middleware/school.js'
import { verifyToken, requireRole } from '../middleware/auth.js'
import { sendComplaintAckEmail }    from '../utils/mailer.js'

const router = Router({ mergeParams: true })

// POST /api/s/:slug/complaints — public complaint submission
router.post('/complaints', attachSchool, async (req, res, next) => {
  try {
    const { student_id, student_name, student_email, reference, subject, body } = req.body

    if (!student_id || !student_name || !student_email || !subject || !body)
      return res.status(400).json({ error: 'student_id, student_name, student_email, subject and body are required' })

    let payment_id = null
    if (reference) {
      const payRes = await pool.query(
        'SELECT id FROM payments WHERE reference = $1 AND school_id = $2',
        [reference, req.school.id]
      )
      if (payRes.rows.length) payment_id = payRes.rows[0].id
    }

    const { rows } = await pool.query(
      `INSERT INTO complaints
         (school_id, payment_id, reference, student_id, student_name, student_email, subject, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.school.id, payment_id, reference || null,
       student_id, student_name, student_email, subject, body]
    )

    sendComplaintAckEmail({ school: req.school, complaint: rows[0] }).catch(console.error)
    res.status(201).json({ complaint: rows[0], message: 'Complaint submitted. We will respond within 2–3 working days.' })
  } catch (err) { next(err) }
})

// GET /api/s/:slug/complaints/track — public complaint status lookup
router.get('/complaints/track', attachSchool, async (req, res, next) => {
  try {
    const { student_email, complaint_id } = req.query
    if (!student_email && !complaint_id)
      return res.status(400).json({ error: 'student_email or complaint_id required' })

    let query, vals
    if (complaint_id) {
      query = `SELECT c.*, json_agg(cr ORDER BY cr.created_at) FILTER (WHERE cr.id IS NOT NULL) AS replies
               FROM complaints c LEFT JOIN complaint_replies cr ON cr.complaint_id = c.id
               WHERE c.id = $1 AND c.school_id = $2 GROUP BY c.id`
      vals = [complaint_id, req.school.id]
    } else {
      query = `SELECT c.*, json_agg(cr ORDER BY cr.created_at) FILTER (WHERE cr.id IS NOT NULL) AS replies
               FROM complaints c LEFT JOIN complaint_replies cr ON cr.complaint_id = c.id
               WHERE c.student_email = $1 AND c.school_id = $2 GROUP BY c.id ORDER BY c.created_at DESC`
      vals = [student_email, req.school.id]
    }
    const { rows } = await pool.query(query, vals)
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/s/:slug/admin/complaints — admin: list complaints with filters
router.get('/admin/complaints', attachSchool, verifyToken,
  requireRole('school_admin','bursar','accountant'), async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query
    const conditions = ['c.school_id = $1']
    const vals = [req.school.id]
    if (status) { conditions.push(`c.status = $2`); vals.push(status) }

    const { rows } = await pool.query(
      `SELECT c.*,
              json_agg(cr ORDER BY cr.created_at) FILTER (WHERE cr.id IS NOT NULL) AS replies
       FROM complaints c
       LEFT JOIN complaint_replies cr ON cr.complaint_id = c.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, limit, offset]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// PATCH /api/s/:slug/admin/complaints/:id/status — admin: update status
router.patch('/admin/complaints/:id/status', attachSchool, verifyToken,
  requireRole('school_admin','bursar'), async (req, res, next) => {
  try {
    const { status } = req.body
    const valid = ['open','in_review','resolved','rejected']
    if (!valid.includes(status))
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` })

    await pool.query(
      `UPDATE complaints SET status = $1, updated_at = NOW() WHERE id = $2 AND school_id = $3`,
      [status, req.params.id, req.school.id]
    )
    res.json({ message: 'Status updated' })
  } catch (err) { next(err) }
})

// POST /api/s/:slug/admin/complaints/:id/reply — admin reply
router.post('/admin/complaints/:id/reply', attachSchool, verifyToken,
  requireRole('school_admin','bursar'), async (req, res, next) => {
  try {
    const { message } = req.body
    if (!message) return res.status(400).json({ error: 'message required' })

    const { rows } = await pool.query(
      `INSERT INTO complaint_replies (complaint_id, responder_id, responder_name, is_admin, message)
       VALUES ($1,$2,$3,true,$4) RETURNING *`,
      [req.params.id, req.user.id, req.user.name, message]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

export default router
