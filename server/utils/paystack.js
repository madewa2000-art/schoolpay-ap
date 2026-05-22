import axios from 'axios'

const BASE = 'https://api.paystack.co'

export async function initializeTransaction({ secretKey, email, amountKobo, reference, callbackUrl, metadata }) {
  const res = await axios.post(
    `${BASE}/transaction/initialize`,
    { email, amount: amountKobo, reference, callback_url: callbackUrl, metadata },
    { headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' } }
  )
  return res.data.data  // { authorization_url, access_code, reference }
}

export async function verifyTransaction({ secretKey, reference }) {
  const res = await axios.get(`${BASE}/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${secretKey}` }
  })
  return res.data.data  // { status, amount, reference, gateway_response, ... }
}

export async function refundTransaction({ secretKey, transactionId, amountKobo }) {
  const body = { transaction: transactionId }
  if (amountKobo) body.amount = amountKobo  // partial refund when specified
  const res = await axios.post(`${BASE}/refund`, body, {
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' }
  })
  return res.data.data  // { status, transaction, amount, ... }
}
