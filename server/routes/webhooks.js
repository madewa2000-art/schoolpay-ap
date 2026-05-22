import { Router }  from 'express'
import crypto      from 'crypto'
import { pool }    from '../db/index.js'
import { generateReceiptNumber } from '../utils/reference.js'
import { sendReceiptEmail }      from '../utils/mailer.js'

const router = Router()

// Converts a DB NUMERIC naira amount to a kobo integer without float precision loss.
function toKobo(nairaAmount) {
  return parseInt(Number(nairaAmount).toFixed(2).replace('.', ''), 10)
}

// POST /api/webhooks/paystack
// req.body is a raw Buffer because express.raw() is mounted on this path in index.js
router.post('/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature']
  const rawBody   = req.body  // Buffer

  // 1. Parse body
  let event
  try {
    event = JSON.parse(rawBody)
  } catch {
    return res.status(400).send('Bad JSON')
  }

  if (event.event !== 'charge.success') return res.sendStatus(200)
  const { reference, amount, status } = event.data
  if (status !== 'success') return res.sendStatus(200)

  // 2. Look up payment to get the school's Paystack secret key for HMAC verification
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

  // 3. Verify HMAC against the raw body bytes — NOT re-serialised JSON.
  //    JSON.stringify(parsedObject) can produce a different byte sequence than
  //    the original payload (key ordering, whitespace), breaking the HMAC check.
  const hash = crypto
    .createHmac('sha512', school.paystack_secret_key)
    .update(rawBody)
    .digest('hex')
  if (hash !== signature) return res.status(401).send('Signature mismatch')

  if (row.status === 'confirmed') return res.sendStatus(200)

  // 4. Verify amount — blocks replayed or tampered webhooks
  const expectedKobo = toKobo(row.amount)
  if (Number(amount) !== expectedKobo) {
    console.error(`PAYMENT_AMOUNT_MISMATCH reference=${reference} expected=${expectedKobo} got=${amount}`)
    return res.sendStatus(200)
  }

  // 5. All validation passed — acknowledge to Paystack immediately
  res.sendStatus(200)

  // 6. Confirm payment and generate receipt atomically
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(
      `UPDATE payments
       SET status = 'confirmed', paystack_ref = $1, confirmed_at = NOW()
       WHERE id = $2 AND status != 'confirmed'`,
      [event.data.id, row.id]
    )

    const receiptNumber = generateReceiptNumber({ slug: school.slug })
    const rcptRes = await client.query(
      `INSERT INTO receipts (school_id, payment_id, receipt_number)
       VALUES ($1,$2,$3) ON CONFLICT (payment_id) DO NOTHING RETURNING *`,
      [row.school_id, row.id, receiptNumber]
    )

    await client.query('COMMIT')

    if (rcptRes.rows.length) {
      sendReceiptEmail({ school, payment: row, receipt: rcptRes.rows[0] }).catch(console.error)
    }
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Webhook processing failed:', { reference, error: err.message })
  } finally {
    client.release()
  }
})

export default router
