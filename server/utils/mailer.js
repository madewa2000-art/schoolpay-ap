import nodemailer from 'nodemailer'

function createTransport(school) {
  if (school.smtp_host) {
    return nodemailer.createTransport({
      host: school.smtp_host,
      port: school.smtp_port || 587,
      secure: school.smtp_port === 465,
      auth: { user: school.smtp_user, pass: school.smtp_pass },
    })
  }
  // fallback: Gmail with app password via env
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

export async function sendReceiptEmail({ school, payment, receipt }) {
  const transport = createTransport(school)
  const from      = school.from_email || process.env.SMTP_USER

  await transport.sendMail({
    from:    `"${school.name}" <${from}>`,
    to:      payment.student_email,
    subject: `Payment Receipt — ${receipt.receipt_number}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2 style="color:#1B4332">${school.name}</h2>
        <h3>Payment Receipt</h3>
        <table style="width:100%;border-collapse:collapse">
          <tr><td><strong>Receipt No.</strong></td><td>${receipt.receipt_number}</td></tr>
          <tr><td><strong>Student Name</strong></td><td>${payment.student_name}</td></tr>
          <tr><td><strong>Student ID</strong></td><td>${payment.student_id}</td></tr>
          <tr><td><strong>Reference</strong></td><td>${payment.reference}</td></tr>
          <tr><td><strong>Amount Paid</strong></td><td>₦${Number(payment.amount).toLocaleString()}</td></tr>
          <tr><td><strong>Payment Method</strong></td><td>${payment.method === 'paystack' ? 'Online (Paystack)' : 'Bank Deposit'}</td></tr>
          <tr><td><strong>Date</strong></td><td>${new Date(receipt.issued_at).toLocaleString()}</td></tr>
        </table>
        <p style="margin-top:24px;color:#666;font-size:12px">
          This is an auto-generated receipt. Please keep it for your records.
        </p>
      </div>
    `,
  })
}

export async function sendComplaintAckEmail({ school, complaint }) {
  const transport = createTransport(school)
  const from      = school.from_email || process.env.SMTP_USER

  await transport.sendMail({
    from:    `"${school.name}" <${from}>`,
    to:      complaint.student_email,
    subject: `Complaint Received — ${complaint.id.slice(0, 8).toUpperCase()}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2 style="color:#1B4332">${school.name}</h2>
        <p>Dear ${complaint.student_name},</p>
        <p>Your complaint has been received and is under review.</p>
        <p><strong>Subject:</strong> ${complaint.subject}</p>
        <p><strong>Reference:</strong> ${complaint.reference || 'N/A'}</p>
        <p>We will respond to you via email within 2–3 working days.</p>
      </div>
    `,
  })
}
