import { Router }       from 'express'
import bcrypt           from 'bcryptjs'
import { pool }         from '../db/index.js'
import { attachSchool } from '../middleware/school.js'
import { verifyToken, requireRole } from '../middleware/auth.js'
import { generateReference, generateReceiptNumber } from '../utils/reference.js'
import { initializeTransaction, refundTransaction, verifyTransaction } from '../utils/paystack.js'
import { confirmPaystackPayment } from '../services/confirm.js'
import { sendReceiptEmail }         from '../utils/mailer.js'
import { normalizeCategory, DEFAULT_CATEGORY } from '../utils/category.js'

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
    // Fees come back grouped-ready: ordered by category, then term, so the
    // portal can render sections without sorting client-side. `?category=` is
    // what a per-category payment link resolves to.
    const wanted = req.query.category ? String(req.query.category) : null
    const { rows: allFees } = await pool.query(
      `SELECT id, name, description, amount, term, academic_year, is_mandatory,
              COALESCE(category, $2)      AS category,
              COALESCE(category_slug, $3) AS category_slug
       FROM payment_types
       WHERE school_id = $1 AND active = true
       ORDER BY COALESCE(category, $2), academic_year NULLS LAST, term NULLS LAST,
                is_mandatory DESC, name`,
      [req.school.id, DEFAULT_CATEGORY, 'general']
    )

    // Every category that has at least one active fee, for the category picker
    // and for the admin's list of shareable links.
    const categories = []
    for (const f of allFees) {
      let c = categories.find((x) => x.slug === f.category_slug)
      if (!c) { c = { name: f.category, slug: f.category_slug, count: 0, total: 0 }; categories.push(c) }
      c.count += 1
      c.total += Number(f.amount || 0)
    }

    const feeTypes = wanted ? allFees.filter((f) => f.category_slug === wanted) : allFees
    if (wanted && !feeTypes.length)
      return res.status(404).json({ error: 'No fees found in that category' })

    res.json({
      categories,
      category: wanted ? { name: feeTypes[0].category, slug: wanted } : null,
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
  const client = await pool.connect()
  try {
    const { payment_type_id, payment_type_ids, student_id, student_name,
            student_email, student_class, method } = req.body

    // One fee or many. `payment_type_id` is still accepted so older links and
    // any cached page keep working; internally everything is a list.
    const requested = [...new Set(
      (Array.isArray(payment_type_ids) && payment_type_ids.length
        ? payment_type_ids
        : [payment_type_id]).filter(Boolean)
    )]

    if (!requested.length || !student_id || !student_name || !student_email || !method)
      return res.status(400).json({ error: 'At least one fee, student_id, student_name, student_email and method are required' })

    // A cap, not a limit anyone will meet: it stops a crafted request asking
    // for thousands of rows in one transaction.
    if (requested.length > 30)
      return res.status(400).json({ error: 'Too many fees in one payment (maximum 30)' })

    if (!['paystack','bank'].includes(method))
      return res.status(400).json({ error: 'method must be paystack or bank' })

    // Amounts always come from the database, never from the request — the
    // payer's browser must not be able to name its own price.
    const feeRes = await pool.query(
      `SELECT * FROM payment_types
       WHERE id = ANY($1::uuid[]) AND school_id = $2 AND active = true`,
      [requested, req.school.id]
    )
    if (feeRes.rows.length !== requested.length)
      return res.status(404).json({ error: 'One or more fee types were not found' })

    const fees  = feeRes.rows
    const total = fees.reduce((sum, f) => sum + Number(f.amount), 0)
    if (!(total > 0))
      return res.status(400).json({ error: 'The selected fees have no amount set. Please contact the school.' })

    const feeIdSet = new Set(fees.map((f) => String(f.id)))
    const single   = fees.length === 1 ? fees[0] : null

    // Resume rather than duplicate.
    //
    // This used to return 409, which was a dead end — a payer who started a
    // bank transfer and came back later could never get past it. Now a pending
    // payment covering exactly the same set of fees is resumed.
    //
    // Amount and method are refreshed on resume, since the payer may have
    // switched method or the school may have repriced a fee. Whether the
    // reference can be reused is decided below, by asking Paystack.
    const { rows: pendings } = await pool.query(
      `SELECT p.*, COALESCE(
                array_agg(pi.payment_type_id::text) FILTER (WHERE pi.payment_type_id IS NOT NULL),
                ARRAY[]::text[]
              ) AS item_type_ids
         FROM payments p
         LEFT JOIN payment_items pi ON pi.payment_id = p.id
        WHERE p.school_id = $1 AND p.student_id = $2 AND p.status = 'pending'
        GROUP BY p.id
        ORDER BY p.created_at DESC`,
      [req.school.id, student_id]
    )
    const resumable = pendings.find((p) => {
      const ids = new Set(
        (p.item_type_ids || []).length
          ? p.item_type_ids.map(String)
          : (p.payment_type_id ? [String(p.payment_type_id)] : [])
      )
      return ids.size === feeIdSet.size && [...feeIdSet].every((id) => ids.has(id))
    })

    // Can the old reference actually be reused?
    //
    // Paystack refuses to start a transaction on a reference it has already
    // seen — the payer gets "Duplicate Transaction Reference" from the popup
    // itself, which no amount of retrying fixes. So before resuming a Paystack
    // payment, ask Paystack what became of the old reference:
    //
    //   success            already paid — confirm it, do not charge again
    //   abandoned/failed   the reference is spent; retire this record and mint
    //   /reversed          a fresh one for the retry
    //   ongoing/pending    the charge may still land; keep the same reference
    //                      rather than risk charging twice
    //   not found          Paystack never saw it; reuse is safe
    //
    // The retired record keeps its own reference rather than having it
    // rewritten, so if that old checkout somehow does settle later, the webhook
    // still finds the row it belongs to and nobody's money goes missing.
    let resume = resumable
    if (resume && method === 'paystack' && req.school.paystack_secret_key) {
      let tx = null
      try {
        tx = await verifyTransaction({ secretKey: req.school.paystack_secret_key, reference: resume.reference })
      } catch {
        tx = null   // unknown reference — safe to reuse
      }

      if (tx?.status === 'success') {
        const out = await confirmPaystackPayment({
          payment: resume, school: req.school, paystackId: tx.id, amountKobo: tx.amount,
        })
        if (out.confirmed) {
          const { rows } = await pool.query(
            `SELECT p.*, pt.name AS fee_type_name, r.receipt_number
               FROM payments p
               LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
               LEFT JOIN receipts r ON r.payment_id = p.id
              WHERE p.id = $1`, [resume.id]
          )
          client.release()
          return res.json({ payment: rows[0], alreadyPaid: true })
        }
      }

      if (tx && ['abandoned', 'failed', 'reversed'].includes(tx.status)) {
        await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'", [resume.id])
        resume = null
      } else if (tx && ['ongoing', 'pending', 'processing', 'queued'].includes(tx.status)) {
        // A charge is still in flight on this reference. Opening the popup again
        // would fail on the duplicate, and minting a new reference could charge
        // the payer twice — so neither. Hand the payer to the verification page,
        // which polls until Paystack settles it either way.
        client.release()
        return res.json({ payment: resume, inProgress: true })
      }
    }

    let payment
    await client.query('BEGIN')
    try {
      if (resume) {
        const { rows } = await client.query(
          `UPDATE payments
              SET method = $1, amount = $2, student_name = $3,
                  student_email = $4, student_class = $5, payment_type_id = $6
            WHERE id = $7
          RETURNING *`,
          [method, total, student_name, student_email, student_class || null,
           single ? single.id : null, resume.id]
        )
        payment = rows[0]
        await client.query('DELETE FROM payment_items WHERE payment_id = $1', [payment.id])
      } else {
        const reference = generateReference({
          slug:            req.school.slug,
          schoolType:      req.school.type,
          paymentTypeName: single ? single.name : 'Multiple Fees',
        })
        const { rows } = await client.query(
          `INSERT INTO payments
             (school_id, payment_type_id, student_id, student_name, student_email, student_class,
              reference, amount, method, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
           RETURNING *`,
          [req.school.id, single ? single.id : null, student_id, student_name, student_email,
           student_class || null, reference, total, method]
        )
        payment = rows[0]
      }

      // Lines are written for every payment, single or not, so the receipt and
      // the clearance check have one shape to read. Name, term and year are
      // snapshotted: the receipt must keep saying what was actually paid for
      // even after the school renames or reprices the fee.
      for (const f of fees) {
        await client.query(
          `INSERT INTO payment_items (payment_id, payment_type_id, name, term, academic_year, amount)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [payment.id, f.id, f.name, f.term, f.academic_year, f.amount]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }

    const reference = payment.reference
    const items = fees.map((f) => ({
      payment_type_id: f.id, name: f.name, term: f.term,
      academic_year: f.academic_year, amount: f.amount,
    }))

    if (method === 'paystack') {
      if (!req.school.paystack_secret_key)
        return res.status(400).json({ error: 'School has not configured Paystack' })

      // Resuming re-initialises a reference Paystack has already seen, which it
      // can reject. That must not block the payer: the inline popup only needs
      // the reference and the public key, so a failed re-initialise is logged
      // and the payment returned anyway. A first attempt still fails hard.
      let paystackData = null
      try {
        paystackData = await initializeTransaction({
          secretKey:   req.school.paystack_secret_key,
          email:       student_email,
          amountKobo:  toKobo(total),
          reference,
          callbackUrl: `${process.env.CLIENT_URL}/portal/verify.html?school=${req.school.slug}&ref=${reference}`,
          metadata:    { student_id, student_name, school: req.school.name, fees: fees.map((f) => f.name) },
        })
      } catch (err) {
        console.error('PAYSTACK_INIT_FAILED', reference, err.response?.data?.message || err.message)
        if (!resume) throw err
      }
      return res.json({ payment, items, paystack: paystackData })
    }

    // bank method — return bank details + reference
    res.json({
      payment,
      items,
      bankDetails: {
        bank_name:         req.school.bank_name,
        account_number:    req.school.bank_account,
        account_name:      req.school.bank_account_name,
        amount:            total,
        reference,
        instruction: `Use reference "${reference}" as your payment narration/description`,
      },
    })
  } catch (err) { next(err) }
  finally { client.release() }
})

// ─── Public: verify Paystack payment after redirect ──────────────────────────
router.get('/payments/verify', attachSchool, async (req, res, next) => {
  try {
    const { ref } = req.query
    if (!ref) return res.status(400).json({ error: 'ref required' })

    // The receipt number lives in `receipts`, not on the payment row. Selecting
    // only from `payments` meant receipt_number was always undefined, so the
    // "View Receipt" button on the success screen never had a link to point at.
    const payRes = await pool.query(
      `SELECT p.*, pt.name AS fee_type_name, r.receipt_number
       FROM payments p
       LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
       LEFT JOIN receipts r ON r.payment_id = p.id
       WHERE p.reference = $1 AND p.school_id = $2`,
      [ref, req.school.id]
    )
    if (!payRes.rows.length) return res.status(404).json({ error: 'Payment not found' })
    let payment = payRes.rows[0]

    // Ask Paystack directly when the record is still pending.
    //
    // Confirmation normally arrives by webhook, but a webhook can be
    // unconfigured, blocked, or simply slow, and the payer is sitting on this
    // page waiting. So when the payment is still pending we check with Paystack
    // ourselves and confirm from the answer. Same code path the webhook uses,
    // so the two cannot diverge, and it is idempotent — whichever arrives first
    // wins and the other is a no-op.
    //
    // This is a read of Paystack's own record using the school's secret key, so
    // it cannot be used to confirm a payment that was never made.
    if (payment.status === 'pending' && payment.method === 'paystack' && req.school.paystack_secret_key) {
      try {
        const tx = await verifyTransaction({ secretKey: req.school.paystack_secret_key, reference: ref })
        if (tx?.status === 'success') {
          const out = await confirmPaystackPayment({
            payment, school: req.school, paystackId: tx.id, amountKobo: tx.amount,
          })
          if (out.confirmed) {
            const { rows } = await pool.query(
              `SELECT p.*, pt.name AS fee_type_name, r.receipt_number
                 FROM payments p
                 LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
                 LEFT JOIN receipts r ON r.payment_id = p.id
                WHERE p.id = $1`, [payment.id]
            )
            payment = rows[0]
          }
        }
      } catch (err) {
        // A Paystack outage must not break the page: fall through and report
        // the payment as it stands, which is what the webhook will fix.
        console.error('VERIFY_FALLBACK_FAILED', ref, err.response?.data?.message || err.message)
      }
    }

    const { rows: items } = await pool.query(
      `SELECT name, term, academic_year, amount FROM payment_items
       WHERE payment_id = $1 ORDER BY name`,
      [payment.id]
    )
    res.json({ ...payment, items })
  } catch (err) { next(err) }
})

// ─── Public: look up payment history by student ID + email ───────────────────
router.get('/payments/history', attachSchool, async (req, res, next) => {
  try {
    const { student_id, student_email } = req.query
    if (!student_id || !student_email)
      return res.status(400).json({ error: 'student_id and student_email required' })

    const { rows } = await pool.query(
      `SELECT p.*, r.receipt_number,
              COALESCE(pt.name, i.item_names) AS fee_type_name,
              COALESCE(i.item_count, 1)       AS item_count
       FROM payments p
       LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
       LEFT JOIN receipts r ON r.payment_id = p.id
       LEFT JOIN LATERAL (
         SELECT string_agg(pi.name || COALESCE(' (' || pi.term || ')', ''), ', ' ORDER BY pi.name, pi.term) AS item_names,
                COUNT(*)                                   AS item_count
         FROM payment_items pi WHERE pi.payment_id = p.id
       ) i ON true
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
    // A multi-fee payment has no single payment_type_id, so the fee column
    // falls back to the names on its lines.
    const { rows } = await pool.query(
      `SELECT p.*, r.receipt_number,
              COALESCE(pt.name, i.item_names) AS fee_type_name,
              COALESCE(i.item_count, 1)       AS item_count
       FROM payments p
       LEFT JOIN payment_types pt ON pt.id = p.payment_type_id
       LEFT JOIN receipts r ON r.payment_id = p.id
       LEFT JOIN LATERAL (
         SELECT string_agg(pi.name || COALESCE(' (' || pi.term || ')', ''), ', ' ORDER BY pi.name, pi.term) AS item_names,
                COUNT(*)                                   AS item_count
         FROM payment_items pi WHERE pi.payment_id = p.id
       ) i ON true
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
      `SELECT *, COALESCE(category, $2) AS category,
              COALESCE(category_slug, 'general') AS category_slug
       FROM payment_types WHERE school_id = $1
       ORDER BY COALESCE(category, $2), academic_year NULLS LAST, term NULLS LAST, created_at`,
      [req.school.id, DEFAULT_CATEGORY]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// Creates a fee type. `terms` creates the same fee once per term in one call —
// setting up "Tuition" for three terms was three trips through the form, and a
// school doing that for eight fee types was doing it twenty-four times.
router.post('/admin/fee-types', attachSchool, verifyToken,
  requireRole('school_admin'), async (req, res, next) => {
  try {
    const { name, description, amount, term, academic_year, is_mandatory, terms } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })

    const { category, category_slug } = normalizeCategory(req.body.category)
    const termList = Array.isArray(terms) && terms.length
      ? [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))]
      : [term]
    if (termList.length > 12)
      return res.status(400).json({ error: 'Too many terms in one request (maximum 12)' })

    const created = []
    for (const t of termList) {
      const { rows } = await pool.query(
        `INSERT INTO payment_types
           (school_id, name, description, amount, term, academic_year, is_mandatory, category, category_slug)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.school.id, name, description, amount || 0, t || null, academic_year,
         is_mandatory ?? true, category, category_slug]
      )
      created.push(rows[0])
    }
    res.status(201).json(created.length === 1 ? created[0] : { created, count: created.length })
  } catch (err) { next(err) }
})

router.patch('/admin/fee-types/:feeId', attachSchool, verifyToken,
  requireRole('school_admin'), async (req, res, next) => {
  try {
    const allowed = ['name','description','amount','term','academic_year','is_mandatory','active']
    const fields  = Object.keys(req.body).filter(k => allowed.includes(k))
    const vals    = fields.map(f => req.body[f])

    // Category is set as a pair — the label and its URL form must stay in step,
    // or the per-category payment link stops finding the fee.
    if (req.body.category !== undefined) {
      const { category, category_slug } = normalizeCategory(req.body.category)
      fields.push('category', 'category_slug')
      vals.push(category, category_slug)
    }
    if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' })

    const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ')
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
              COALESCE(pt.name, (
                SELECT string_agg(pi.name || COALESCE(' (' || pi.term || ')', ''), ' + ' ORDER BY pi.name, pi.term)
                FROM payment_items pi WHERE pi.payment_id = p.id
              )) AS fee_type,
              p.reference, p.amount, p.method,
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
