import { pool } from '../db/index.js'
import { generateReceiptNumber } from '../utils/reference.js'
import { sendReceiptEmail } from '../utils/mailer.js'

// Converts a DB NUMERIC naira amount to a kobo integer without float precision loss.
export function toKobo(nairaAmount) {
  return parseInt(Number(nairaAmount).toFixed(2).replace('.', ''), 10)
}

/**
 * Marks a Paystack payment confirmed and issues its receipt, in one transaction.
 *
 * Shared by the webhook and by the verify endpoint's fallback, so the two can
 * never confirm a payment differently. Safe to call twice: an already-confirmed
 * payment is a no-op, and the receipt insert is ON CONFLICT DO NOTHING, so a
 * webhook and a page refresh racing each other produce one receipt, not two.
 *
 * The caller is responsible for having verified with Paystack that the charge
 * actually succeeded — this function checks the amount, not the authenticity.
 *
 * @returns {{ confirmed: boolean, receiptNumber: string|null, reason?: string }}
 */
export async function confirmPaystackPayment({ payment, school, paystackId, amountKobo }) {
  if (payment.status === 'confirmed') {
    const { rows } = await pool.query(
      'SELECT receipt_number FROM receipts WHERE payment_id = $1', [payment.id]
    )
    return { confirmed: true, receiptNumber: rows[0]?.receipt_number || null, reason: 'already' }
  }

  // Blocks a tampered or replayed confirmation: the charge has to be for the
  // amount we recorded, to the kobo.
  const expected = toKobo(payment.amount)
  if (Number(amountKobo) !== expected) {
    console.error(`PAYMENT_AMOUNT_MISMATCH reference=${payment.reference} expected=${expected} got=${amountKobo}`)
    return { confirmed: false, receiptNumber: null, reason: 'amount_mismatch' }
  }

  const receiptNumber = generateReceiptNumber({ slug: school.slug })
  const client = await pool.connect()
  let issued = null
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE payments
          SET status = 'confirmed', paystack_ref = COALESCE($1, paystack_ref), confirmed_at = NOW()
        WHERE id = $2 AND status <> 'confirmed'`,
      [paystackId || null, payment.id]
    )
    const rcpt = await client.query(
      `INSERT INTO receipts (school_id, payment_id, receipt_number)
       VALUES ($1,$2,$3) ON CONFLICT (payment_id) DO NOTHING RETURNING *`,
      [payment.school_id, payment.id, receiptNumber]
    )
    await client.query('COMMIT')
    issued = rcpt.rows[0] || null
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  if (issued) {
    sendReceiptEmail({ school, payment, receipt: issued }).catch(console.error)
    return { confirmed: true, receiptNumber: issued.receipt_number }
  }

  // Someone else won the race and inserted the receipt — read theirs.
  const { rows } = await pool.query(
    'SELECT receipt_number FROM receipts WHERE payment_id = $1', [payment.id]
  )
  return { confirmed: true, receiptNumber: rows[0]?.receipt_number || null, reason: 'raced' }
}
