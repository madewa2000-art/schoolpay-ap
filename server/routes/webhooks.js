import { Router }  from 'express'
import { pool }    from '../db/index.js'
import { verifySignature } from '../utils/paystack.js'
import { generateReceiptNumber } from '../utils/reference.js'
import { sendReceiptEmail }      from '../utils/mailer.js'

const router = Router()

// POST /api/webhooks/paystack
// Paystack sends raw JSON body; we verify the HMAC before trusting it
router.post('/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature']

  // req.body is a Buffer (raw) because of express.raw() on this path
  let event
  try {
    event = JSON.parse(req.body)
  } catch {
    return res.status(400).send('Bad JSON')
  }

  if (event.event !== 'charge.success') return res.sendStatus(200)

  const { reference, amount, status } = event.data
  if (status !== 'success') return res.sendStatus(200)

  // Look up the payment by reference to get the school's secret key for verification
  const payRes = await pool.query(
    `SELECT p.*, s.paystack_secret_key, s.name AS school_name,
            s.slug, s.type AS school_type,
            s.bank_name, s.bank_account, s.bank_account_name,
            s.from_email, s.smtp_host, s.smtp_port, s.smtp_user, s.smtp_pass
     FROM payments p JOIN schools s ON s.id = p.school_id
     WHERE p.reference = $1`,
    [reference]
  )
  if (!payRes.rows.length) return res.sendStatus(200)

  const row    = payRes.rows[0]
  const school = {
    id: row.school_id, name: row.school_name, slug: row.slug,
    type: row.school_type, from_email: row.from_email,
    smtp_host: row.smtp_host, smtp_port: row.smtp_port,
    smtp_user: row.smtp_user, smtp_pass: row.smtp_pass,
    paystack_secret_key: row.paystack_secret_key,
  }

  // Verify HMAC with this school's own Paystack secret
  if (!verifySignature(event, signature, school.paystack_secret_key)) {
    return res.status(401).send('Signature mismatch')
  }

  if (row.status === 'confirmed') return res.sendStatus(200)

  // Verify amount matches (Paystack amount is in kobo)
  const expectedKobo = Math.round(Number(row.amount) * 100)
  if (Number(amount) !== expectedKobo) {
    console.warn(`Amount mismatch for ${reference}: expected ${expectedKobo}, got ${amount}`)
    return res.sendStatus(200)
  }

  // Confirm payment
  await pool.query(
    `UPDATE payments
     SET status = 'confirmed', paystack_ref = $1, confirmed_at = NOW()
     WHERE id = $2`,
    [event.data.id, row.id]
  )

  // Generate receipt
  const seqRes = await pool.query(
    'SELECT COUNT(*) AS cnt FROM receipts WHERE school_id = $1',
    [row.school_id]
  )
  const receiptNumber = generateReceiptNumber({
    slug:     school.slug,
    sequence: Number(seqRes.rows[0].cnt) + 1,
  })
  const rcptRes = await pool.query(
    `INSERT INTO receipts (school_id, payment_id, receipt_number)
     VALUES ($1,$2,$3) ON CONFLICT (payment_id) DO NOTHING RETURNING *`,
    [row.school_id, row.id, receiptNumber]
  )

  if (rcptRes.rows.length) {
    sendReceiptEmail({ school, payment: row, receipt: rcptRes.rows[0] }).catch(console.error)
  }

  res.sendStatus(200)
})

export default router
