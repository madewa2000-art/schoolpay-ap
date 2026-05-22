import { Router }       from 'express'
import bcrypt           from 'bcryptjs'
import { pool }         from '../db/index.js'
import { attachSchool } from '../middleware/school.js'
import { verifyToken, requireRole } from '../middleware/auth.js'
import { generateReference, generateReceiptNumber } from '../utils/reference.js'
import { initializeTransaction, refundTransaction } from '../utils/paystack.js'
import { sendReceiptEmail }         from '../utils/mailer.js'

const router = Router({ mergeParams: true })

// Converts a DB NUMERIC naira amount to a kobo integer without float precision loss.
function toKobo(nairaAmount) {
  return parseInt(Number(nairaAmount).toFixed(2).replace('.', ''), 10)
}

// Escapes a CSV field value: doubles embedded quotes and prefixes formula characters
// to prevent CSV injection when the file is opened in Excel or Google Sheets.
function csvEscape(value) {
  if (value === null || value === undefined) return '""'
  const str     = String(value).replace(/"/g, '""')
  const safe    = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str
  return `"${safe}"`
}

// ─── Public: get school info + active fee types (for student payment form) ───
router.get('/public', attachSchool, async (req, res, next) => {
  try {
    const { rows: feeTypes } = await pool.query(
      `SELECT id, name, description, amount, term, academic_year, is_mandatory
       FROM payment_types
       WHERE school_id = $1 AND active = true
       ORDER BY is_mandatory DESC, name`,
      [req.school.id]
    )
    res.json({
      school: {
        id:               req.school.id,
        name:             req.school.name,
        slug:             req.school.slug,
        type:             req.school.type,
        logo_url:         req.school.logo_url,
        bank_name:        req.school.bank_name,
        bank_account:     req.school.bank_account,
        bank_account_name: req.school.bank_account_name,
        paystack_public_key: req.school.paystack_public_key,
      },
      feeTypes,
    })
  } catch (err) { next(err) }
})

// ─── Public: initiate a payment ───────────────────────────────────────────────
router.post('/payments/initiate', attachSchool, async (req, res, next) => {
  try {
    const { payment_type_id, student_id, student_name, student_email, student_class, method } = req.body

    if (!payment_type_id || !student_id || !student_name || !student_email || !method)
      return res.status(400).json({ error: 'payment_type_id, student_id, student_name, student_email and method are required' })

    if (!['paystack','bank'].includes(method))
      return res.status(400).json({ error: 'method must be paystack or bank' })

    const feeRes = await pool.query(
      'SELECT * FROM payment_types WHERE id = $1 AND school_id = $2 AND active = true',
      [payment_type_id, req.school.id]
    )
    if (!feeRes.rows.length)
      return res.status(404).json({ error: 'Fee type not found' })

    const fee = feeRes.rows[0]

    // Idempotency: prevent duplicate charges for the same student + fee
    const dupCheck = await pool.query(
      `SELECT id, reference FROM payments
       WHERE school_id = $1 AND student_id = $2 AND payment_type_id = $3 AND status = 'pending'
       LIMIT 1`,
      [req.school.id, student_id, payment_type_id]
    )
    if (dupCheck.rows.length) {
      return res.status(409).json({
        error: 'A pending payment already exists for this student and fee type.',
        existing_reference: dupCheck.rows[0].reference,
      })
    }

    const reference = generateReference({
      slug:            req.school.slug,
      schoolType:      req.school.type,
      paymentTypeName: fee.name,
    })

    const { rows } = await pool.query(
      `INSERT INTO payments
         (school_id, payment_type_id, student_id, student_name, student_email, student_class,
          reference, amount, method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
       RETURNING *`,
      [req.school.id, payment_type_id, student_id, student_name, student_email,
       student_class || null, reference, fee.amount, method]
    )
    const payment = rows[0]

    if (method === 'paystack') {
      if (!req.school.paystack_secret_key)
        return res.status(400).json({ error: 'School has not configured Paystack' })

      const paystackData = await initializeTransaction({
        secretKey:   req.school.paystack_secret_key,
        email:       student_email,
        amountKobo:  toKobo(fee.amount),
        reference,
        callbackUrl: `${process.env.CLIENT_URL}/portal/verify.html?school=${req.school.slug}&ref=${reference}`,
        metadata:    { student_id, student_name, school: req.school.name },
      })
      return res.json({ payment, paystack: paystackData })
    }

    // bank method — return bank details + reference
    res.json({
      payment,
      bankDetails: {
        bank_name:         req.school.bank_name,
        account_number:    req.school.bank_account,
        account_name:      req.school.bank_account_name,
        amount:            fee.amount,
        reference,
        instruction: `Use reference "${reference}" as your payment narration/description`,
      },
    })
  } catch (err) { next(err) }
})

// ─── Public: verify Paystack payment after redirect ──────────────────────────
router.get('/payments/verify', attachSchool, async (req, res, next) => {
  try {
    const { ref } = req.query
    if (!ref) return res.status(400).json({ error: 'ref required' })

    const payRes = await pool.query(
      'SELECT * FROM payments WHERE reference = $1 AND school_id = $2',
      [ref, req.school.id]
    )
    if (!payRes.rows.length) return res.status(404).json({ error: 'Payment not found' })

    res.json(payRes.rows[0])
  } catch (err) { next(err) }
})

// ─── Public: look up payment history by student ID + email ───────────────────
router.get('/payments/history', attachSchool, async (req, res, next) => {
  try {
    const { student_id, student_email } = req.query
    if (!student_id || !student_email)
      return res.status(400).json({ error: 'student_id and student_email required' })

    const { rows } = await pool.query(
      `SELECT p.*, pt.name AS fee_type_name, r.receipt_number
       FROM payments p
       LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
       LEFT JOIN receipts r ON r.payment_id = p.id
       WHERE p.school_id = $1 AND p.student_id = $2 AND p.student_email = $3
       ORDER BY p.created_at DESC`,
      [req.school.id, student_id, student_email]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// ─── Admin: list all payments with filters ────────────────────────────────────
router.get('/admin/payments', attachSchool, verifyToken,
  requireRole('school_admin','bursar','accountant'), async (req, res, next) => {
  try {
    const { status, method, student_id, reference, from, to, limit = 50, offset = 0 } = req.query
    const conditions = ['p.school_id = $1']
    const vals       = [req.school.id]
    let i = 2

    if (status)     { conditions.push(`p.status = $${i++}`);         vals.push(status) }
    if (method)     { conditions.push(`p.method = $${i++}`);         vals.push(method) }
    if (student_id) { conditions.push(`p.student_id ILIKE $${i++}`); vals.push(`%${student_id}%`) }
    if (reference)  { conditions.push(`p.reference ILIKE $${i++}`);  vals.push(`%${reference}%`) }
    if (from)       { conditions.push(`p.created_at >= $${i++}`);    vals.push(from) }
    if (to)         { conditions.push(`p.created_at <= $${i++}`);    vals.push(to) }

    const where = conditions.join(' AND ')
    const { rows } = await pool.query(
      `SELECT p.*, pt.name AS fee_type_name, r.receipt_number
       FROM payments p
       LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
       LEFT JOIN receipts r ON r.payment_id = p.id
       WHERE ${where}
       ORDER BY p.created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...vals, limit, offset]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// ─── Admin: manually confirm a bank payment ───────────────────────────────────
router.patch('/admin/payments/:paymentId/confirm', attachSchool, verifyToken,
  requireRole('school_admin','bursar'), async (req, res, next) => {
  try {
    const { paymentId } = req.params

    const payRes = await pool.query(
      'SELECT * FROM payments WHERE id = $1 AND school_id = $2',
      [paymentId, req.school.id]
    )
    if (!payRes.rows.length) return res.status(404).json({ error: 'Payment not found' })
    const payment = payRes.rows[0]
    if (payment.status === 'confirmed') return res.json({ message: 'Already confirmed', payment })

    const receiptNumber = generateReceiptNumber({ slug: req.school.slug })
    const client = await pool.connect()
    let rcptRes
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE payments SET status = 'confirmed', confirmed_at = NOW(), confirmed_by = $1
         WHERE id = $2`,
        [req.user.id, paymentId]
      )
      rcptRes = await client.query(
        `INSERT INTO receipts (school_id, payment_id, receipt_number)
         VALUES ($1,$2,$3)
         ON CONFLICT (payment_id) DO NOTHING
         RETURNING *`,
        [req.school.id, paymentId, receiptNumber]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    if (rcptRes.rows.length) {
      sendReceiptEmail({ school: req.school, payment, receipt: rcptRes.rows[0] }).catch(console.error)
    }

    res.json({ message: 'Payment confirmed', receiptNumber })
  } catch (err) { next(err) }
})

// ─── Admin: refund a confirmed Paystack payment ───────────────────────────────
router.post('/admin/payments/:paymentId/refund', attachSchool, verifyToken,
  requireRole('school_admin'), async (req, res, next) => {
  try {
    const { paymentId } = req.params

    const payRes = await pool.query(
      'SELECT * FROM payments WHERE id = $1 AND school_id = $2',
      [paymentId, req.school.id]
    )
    if (!payRes.rows.length) return res.status(404).json({ error: 'Payment not found' })
    const payment = payRes.rows[0]

    if (payment.status !== 'confirmed')
      return res.status(400).json({ error: 'Only confirmed payments can be refunded' })
    if (payment.method !== 'paystack')
      return res.status(400).json({ error: 'Only Paystack payments can be refunded via this endpoint. Bank transfers must be handled manually.' })
    if (!payment.paystack_ref)
      return res.status(400).json({ error: 'No Paystack transaction ID on record for this payment' })
    if (!req.school.paystack_secret_key)
      return res.status(400).json({ error: 'School has no Paystack secret key configured' })

    await refundTransaction({
      secretKey:     req.school.paystack_secret_key,
      transactionId: payment.paystack_ref,
    })

    // Paystack accepted the refund — now mark both records atomically.
    // If this transaction fails, the refund is still in flight on Paystack's side;
    // an operator can reconcile via the Paystack dashboard.
    const refundClient = await pool.connect()
    try {
      await refundClient.query('BEGIN')
      await refundClient.query(
        `UPDATE payments SET status = 'refunded' WHERE id = $1`,
        [paymentId]
      )
      await refundClient.query(
        `UPDATE receipts SET voided = true, voided_at = NOW(), voided_by = $1
         WHERE payment_id = $2`,
        [req.user.id, paymentId]
      )
      await refundClient.query('COMMIT')
    } catch (err) {
      await refundClient.query('ROLLBACK')
      throw err
    } finally {
      refundClient.release()
    }

    res.json({ message: 'Refund submitted to Paystack. Student will be refunded within 5–10 business days.' })
  } catch (err) {
    if (err.response?.data?.message) {
      return res.status(400).json({ error: `Paystack error: ${err.response.data.message}` })
    }
    next(err)
  }
})

// ─── Admin: fee types CRUD ────────────────────────────────────────────────────
router.get('/admin/fee-types', attachSchool, verifyToken,
  requireRole('school_admin','bursar','accountant'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM payment_types WHERE school_id = $1 ORDER BY created_at',
      [req.school.id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

router.post('/admin/fee-types', attachSchool, verifyToken,
  requireRole('school_admin'), async (req, res, next) => {
  try {
    const { name, description, amount, term, academic_year, is_mandatory } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })
    const { rows } = await pool.query(
      `INSERT INTO payment_types (school_id, name, description, amount, term, academic_year, is_mandatory)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.school.id, name, description, amount || 0, term, academic_year, is_mandatory ?? true]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

router.patch('/admin/fee-types/:feeId', attachSchool, verifyToken,
  requireRole('school_admin'), async (req, res, next) => {
  try {
    const allowed = ['name','description','amount','term','academic_year','is_mandatory','active']
    const fields  = Object.keys(req.body).filter(k => allowed.includes(k))
    if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' })

    const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ')
    const vals = fields.map(f => req.body[f])
    const { rows } = await pool.query(
      `UPDATE payment_types SET ${sets}
       WHERE id = $1 AND school_id = $2 RETURNING *`,
      [req.params.feeId, req.school.id, ...vals]
    )
    if (!rows.length) return res.status(404).json({ error: 'Fee type not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.delete('/admin/fee-types/:feeId', attachSchool, verifyToken,
  requireRole('school_admin'), async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE payment_types SET active = false WHERE id = $1 AND school_id = $2',
      [req.params.feeId, req.school.id]
    )
    res.json({ message: 'Fee type archived' })
  } catch (err) { next(err) }
})

// ─── Admin: dashboard stats ───────────────────────────────────────────────────
router.get('/admin/stats', attachSchool, verifyToken,
  requireRole('school_admin','bursar','accountant'), async (req, res, next) => {
  try {
    const [paymentsRes, pendingDocsRes, openComplaintsRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                                AS total_payments,
          COUNT(*) FILTER (WHERE status = 'confirmed')           AS confirmed,
          COUNT(*) FILTER (WHERE status = 'pending')             AS pending,
          COALESCE(SUM(amount) FILTER (WHERE status='confirmed'),0) AS total_collected,
          COALESCE(SUM(amount) FILTER (WHERE status='confirmed'
            AND created_at >= date_trunc('month', NOW())), 0)    AS collected_this_month
        FROM payments WHERE school_id = $1
      `, [req.school.id]),
      pool.query(
        `SELECT COUNT(*) AS cnt FROM bank_documents
         WHERE school_id = $1 AND review_status = 'pending'`, [req.school.id]
      ),
      pool.query(
        `SELECT COUNT(*) AS cnt FROM complaints
         WHERE school_id = $1 AND status IN ('open','in_review')`, [req.school.id]
      ),
    ])
    res.json({
      ...paymentsRes.rows[0],
      pending_documents: pendingDocsRes.rows[0].cnt,
      open_complaints:   openComplaintsRes.rows[0].cnt,
    })
  } catch (err) { next(err) }
})

// ─── Admin: staff management ──────────────────────────────────────────────────
router.get('/admin/staff', attachSchool, verifyToken,
  requireRole('school_admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, active, created_at FROM users WHERE school_id = $1 ORDER BY created_at',
      [req.school.id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

router.post('/admin/staff', attachSchool, verifyToken,
  requireRole('school_admin'), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body
    if (!name || !email || !password || !role)
      return res.status(400).json({ error: 'name, email, password and role are required' })
    if (!['bursar','accountant'].includes(role))
      return res.status(400).json({ error: 'role must be bursar or accountant' })

    const hash = await bcrypt.hash(password, 10)
    const { rows } = await pool.query(
      `INSERT INTO users (school_id, name, email, role, password_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role`,
      [req.school.id, name, email, role, hash]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists in this school' })
    next(err)
  }
})

// ─── Admin: CSV export ────────────────────────────────────────────────────────
router.get('/admin/payments/export', attachSchool, verifyToken,
  requireRole('school_admin','accountant'), async (req, res, next) => {
  try {
    const { from, to } = req.query
    const conditions = ['p.school_id = $1', "p.status = 'confirmed'"]
    const vals = [req.school.id]
    let i = 2
    if (from) { conditions.push(`p.created_at >= $${i++}`); vals.push(from) }
    if (to)   { conditions.push(`p.created_at <= $${i++}`); vals.push(to) }

    const { rows } = await pool.query(
      `SELECT p.student_id, p.student_name, p.student_email, p.student_class,
              pt.name AS fee_type, p.reference, p.amount, p.method,
              p.confirmed_at, r.receipt_number
       FROM payments p
       LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
       LEFT JOIN receipts r ON r.payment_id = p.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.confirmed_at DESC`,
      vals
    )

    const header = 'Student ID,Student Name,Email,Class,Fee Type,Reference,Amount,Method,Confirmed At,Receipt No\n'
    const csv    = rows.map(r =>
      [r.student_id, r.student_name, r.student_email, r.student_class || '',
       r.fee_type, r.reference, r.amount, r.method,
       r.confirmed_at, r.receipt_number || ''].map(csvEscape).join(',')
    ).join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="payments-${Date.now()}.csv"`)
    res.send(header + csv)
  } catch (err) { next(err) }
})

export default router
