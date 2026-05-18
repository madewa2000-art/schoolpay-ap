import { Router }       from 'express'
import { pool }         from '../db/index.js'
import { attachSchool } from '../middleware/school.js'
import { verifyToken, requireRole } from '../middleware/auth.js'

const router = Router({ mergeParams: true })

// GET /api/s/:slug/receipts/:receiptNumber — public receipt lookup by number
router.get('/receipts/:receiptNumber', attachSchool, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, p.student_id, p.student_name, p.student_email, p.student_class,
              p.reference, p.amount, p.method, p.confirmed_at,
              pt.name AS fee_type, s.name AS school_name, s.logo_url
       FROM receipts r
       JOIN payments p ON p.id = r.payment_id
       LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
       JOIN schools s ON s.id = r.school_id
       WHERE r.receipt_number = $1 AND r.school_id = $2 AND r.voided = false`,
      [req.params.receiptNumber, req.school.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Receipt not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/s/:slug/clearance — public clearance check (all mandatory fees paid?)
router.get('/clearance', attachSchool, async (req, res, next) => {
  try {
    const { student_id, student_email, academic_year, term } = req.query
    if (!student_id || !student_email)
      return res.status(400).json({ error: 'student_id and student_email required' })

    const conditions = ['pt.school_id = $1', 'pt.is_mandatory = true', 'pt.active = true']
    const vals = [req.school.id]
    let i = 2
    if (academic_year) { conditions.push(`pt.academic_year = $${i++}`); vals.push(academic_year) }
    if (term)          { conditions.push(`pt.term = $${i++}`);          vals.push(term) }

    const { rows: feeTypes } = await pool.query(
      `SELECT pt.id, pt.name, pt.amount, pt.term, pt.academic_year,
              p.status, p.reference, r.receipt_number
       FROM payment_types pt
       LEFT JOIN payments p ON p.payment_type_id = pt.id
         AND p.student_id = $${i++} AND p.student_email = $${i++}
         AND p.status = 'confirmed'
       LEFT JOIN receipts r ON r.payment_id = p.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY pt.name`,
      [...vals, student_id, student_email]
    )

    const allCleared = feeTypes.every(f => f.status === 'confirmed')

    res.json({
      student_id,
      school_name:  req.school.name,
      school_type:  req.school.type,
      is_cleared:   allCleared,
      fee_breakdown: feeTypes,
      generated_at: new Date().toISOString(),
    })
  } catch (err) { next(err) }
})

// PATCH /api/s/:slug/admin/receipts/:receiptId/void — admin void a receipt
router.patch('/admin/receipts/:receiptId/void', attachSchool, verifyToken,
  requireRole('school_admin'), async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE receipts SET voided = true, voided_at = NOW(), voided_by = $1
       WHERE id = $2 AND school_id = $3`,
      [req.user.id, req.params.receiptId, req.school.id]
    )
    res.json({ message: 'Receipt voided' })
  } catch (err) { next(err) }
})

export default router
