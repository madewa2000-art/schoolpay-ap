import { Router }       from 'express'
import { pool }         from '../db/index.js'
import { attachSchool } from '../middleware/school.js'
import { upload }       from '../middleware/upload.js'
import { verifyToken, requireRole } from '../middleware/auth.js'
import { generateReceiptNumber }    from '../utils/reference.js'
import { sendReceiptEmail }         from '../utils/mailer.js'

const router = Router({ mergeParams: true })

// POST /api/s/:slug/documents/upload
// Public — student uploads bank proof against a reference
router.post('/documents/upload', attachSchool, upload.single('document'), async (req, res, next) => {
  try {
    const { reference } = req.body
    if (!reference || !req.file)
      return res.status(400).json({ error: 'reference and document file are required' })

    const payRes = await pool.query(
      `SELECT * FROM payments WHERE reference = $1 AND school_id = $2 AND method = 'bank'`,
      [reference, req.school.id]
    )
    if (!payRes.rows.length)
      return res.status(404).json({ error: 'Bank payment not found for this reference' })

    const payment = payRes.rows[0]
    if (payment.status === 'confirmed')
      return res.status(409).json({ error: 'This payment is already confirmed' })

    // req.file.path is the Cloudinary URL when using CloudinaryStorage
    const fileUrl = req.file.path || req.file.secure_url
    const { rows } = await pool.query(
      `INSERT INTO bank_documents
         (school_id, payment_id, file_path, file_name, file_size, mime_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.school.id, payment.id, fileUrl, req.file.originalname,
       req.file.size, req.file.mimetype]
    )

    res.status(201).json({ document: rows[0], message: 'Document uploaded. Awaiting review.' })
  } catch (err) { next(err) }
})

// GET /api/s/:slug/admin/documents — bursar review queue
router.get('/admin/documents', attachSchool, verifyToken,
  requireRole('school_admin','bursar'), async (req, res, next) => {
  try {
    const { status = 'pending' } = req.query
    const { rows } = await pool.query(
      `SELECT d.*, p.reference, p.student_name, p.student_id, p.student_email,
              p.amount, p.created_at AS payment_date, pt.name AS fee_type
       FROM bank_documents d
       JOIN payments p ON p.id = d.payment_id
       LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
       WHERE d.school_id = $1 AND d.review_status = $2
       ORDER BY d.uploaded_at DESC`,
      [req.school.id, status]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// PATCH /api/s/:slug/admin/documents/:docId/review — approve or reject
router.patch('/admin/documents/:docId/review', attachSchool, verifyToken,
  requireRole('school_admin','bursar'), async (req, res, next) => {
  try {
    const { action, note } = req.body  // action: 'approve' | 'reject'
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ error: 'action must be approve or reject' })

    const docRes = await pool.query(
      'SELECT * FROM bank_documents WHERE id = $1 AND school_id = $2',
      [req.params.docId, req.school.id]
    )
    if (!docRes.rows.length) return res.status(404).json({ error: 'Document not found' })
    const doc = docRes.rows[0]

    await pool.query(
      `UPDATE bank_documents
       SET review_status = $1, reviewed_by = $2, review_note = $3, reviewed_at = NOW()
       WHERE id = $4`,
      [action === 'approve' ? 'approved' : 'rejected', req.user.id, note || null, doc.id]
    )

    if (action === 'approve') {
      const payRes = await pool.query(
        `UPDATE payments SET status = 'confirmed', confirmed_at = NOW(), confirmed_by = $1
         WHERE id = $2 AND status != 'confirmed' RETURNING *`,
        [req.user.id, doc.payment_id]
      )

      if (payRes.rows.length) {
        const payment = payRes.rows[0]

        const seqRes = await pool.query(
          'SELECT COUNT(*) AS cnt FROM receipts WHERE school_id = $1',
          [req.school.id]
        )
        const receiptNumber = generateReceiptNumber({
          slug:     req.school.slug,
          sequence: Number(seqRes.rows[0].cnt) + 1,
        })
        const rcptRes = await pool.query(
          `INSERT INTO receipts (school_id, payment_id, receipt_number)
           VALUES ($1,$2,$3) ON CONFLICT (payment_id) DO NOTHING RETURNING *`,
          [req.school.id, payment.id, receiptNumber]
        )
        if (rcptRes.rows.length) {
          sendReceiptEmail({ school: req.school, payment, receipt: rcptRes.rows[0] }).catch(console.error)
        }
      }
    }

    res.json({ message: `Document ${action}d` })
  } catch (err) { next(err) }
})

export default router
