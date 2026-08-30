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

    // A receipt covering several fees itemises them; a single-fee receipt still
    // has one line, so the receipt page has one shape to render either way.
    const { rows: items } = await pool.query(
      `SELECT name, term, academic_year, amount FROM payment_items
       WHERE payment_id = $1 ORDER BY name`,
      [rows[0].payment_id]
    )
    res.json({ ...rows[0], items })
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

    // A fee is cleared if a confirmed payment covers it — either as the whole
    // payment (payment_type_id) or as one line of a combined payment
    // (payment_items). Before multi-fee payments existed only the first case
    // was checked, so paying three fees together left all three showing as
    // outstanding on the clearance certificate.
    const sid = i++, semail = i++
    const { rows: feeTypes } = await pool.query(
      `SELECT pt.id, pt.name, pt.amount, pt.term, pt.academic_year, pt.category,
              paid.status, paid.reference, paid.receipt_number
       FROM payment_types pt
       LEFT JOIN LATERAL (
         SELECT p.status, p.reference, r.receipt_number
         FROM payments p
         LEFT JOIN payment_items pi ON pi.payment_id = p.id
         LEFT JOIN receipts r ON r.payment_id = p.id
         WHERE p.school_id = pt.school_id
           AND p.student_id = $${sid} AND p.student_email = $${semail}
           AND p.status = 'confirmed'
           AND (p.payment_type_id = pt.id OR pi.payment_type_id = pt.id)
         ORDER BY p.confirmed_at DESC NULLS LAST
         LIMIT 1
       ) paid ON true
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
