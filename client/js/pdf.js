// Requires jsPDF loaded from CDN: https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js

function printReceipt(receipt) {
  const { jsPDF } = window.jspdf
  const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const w    = doc.internal.pageSize.getWidth()
  const fmt  = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })
  const date = (d) => d ? new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }) : ''

  // Header bar
  doc.setFillColor(15, 36, 25)
  doc.rect(0, 0, w, 30, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(18); doc.setFont('helvetica', 'bold')
  doc.text(receipt.school_name || 'School', 14, 13)
  doc.setFontSize(11); doc.setFont('helvetica', 'normal')
  doc.text('OFFICIAL PAYMENT RECEIPT', 14, 21)

  // Receipt number + date (top-right)
  doc.setFontSize(10)
  doc.text(`Receipt: ${receipt.receipt_number}`, w - 14, 13, { align: 'right' })
  doc.text(date(receipt.issued_at), w - 14, 21, { align: 'right' })

  // Body
  doc.setTextColor(30, 30, 30)
  let y = 44
  const row = (label, value, shade) => {
    if (shade) { doc.setFillColor(243, 244, 246); doc.rect(14, y - 5, w - 28, 10, 'F') }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(label, 16, y)
    doc.setFont('helvetica', 'normal'); doc.text(String(value || '—'), 75, y)
    y += 12
  }

  row('Student Name',    receipt.student_name,  false)
  row('Student ID',      receipt.student_id,    true)
  row('Class / Level',   receipt.student_class || '—', false)
  row('Fee Type',        receipt.fee_type,      true)
  row('Reference',       receipt.reference,     false)
  row('Payment Method',  receipt.method === 'paystack' ? 'Online (Paystack)' : 'Bank Deposit', true)
  row('Date Confirmed',  date(receipt.confirmed_at), false)

  // Amount block
  y += 4
  doc.setFillColor(27, 67, 50)
  doc.rect(14, y - 5, w - 28, 14, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13)
  doc.text('AMOUNT PAID', 16, y + 4)
  doc.setFontSize(14)
  doc.text(fmt(receipt.amount), w - 16, y + 4, { align: 'right' })

  // Footer
  doc.setTextColor(120, 120, 120)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  doc.text('This is a computer-generated receipt and is valid without a physical signature.', w / 2, 275, { align: 'center' })

  doc.save(`Receipt-${receipt.receipt_number}.pdf`)
}

function printClearance(data) {
  const { jsPDF } = window.jspdf
  const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const w    = doc.internal.pageSize.getWidth()
  const fmt  = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })
  const date = (d) => d ? new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }) : ''

  // Header
  doc.setFillColor(15, 36, 25)
  doc.rect(0, 0, w, 36, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(20); doc.setFont('helvetica', 'bold')
  doc.text(data.school_name, w / 2, 14, { align: 'center' })
  doc.setFontSize(12); doc.setFont('helvetica', 'normal')
  doc.text('SCHOOL FEES CLEARANCE CERTIFICATE', w / 2, 24, { align: 'center' })
  doc.setFontSize(9)
  doc.text(`Generated: ${date(data.generated_at)}`, w / 2, 32, { align: 'center' })

  // Status badge
  let y = 50
  const cleared = data.is_cleared
  doc.setFillColor(cleared ? 46 : 198, cleared ? 125 : 40, cleared ? 50 : 40)
  doc.roundedRect(w / 2 - 40, y - 6, 80, 14, 3, 3, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
  doc.text(cleared ? '✓ FULLY CLEARED' : '✗ OUTSTANDING FEES', w / 2, y + 3, { align: 'center' })

  y += 20
  doc.setTextColor(30, 30, 30)
  doc.setFontSize(10); doc.setFont('helvetica', 'bold')
  doc.text(`Student ID: ${data.student_id}`, 14, y); y += 14

  // Table header
  doc.setFillColor(27, 67, 50)
  doc.rect(14, y - 5, w - 28, 10, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(9)
  doc.text('Fee Type', 16, y + 1)
  doc.text('Amount', 100, y + 1)
  doc.text('Status', 130, y + 1)
  doc.text('Receipt No.', 165, y + 1)
  y += 12

  data.fee_breakdown.forEach((f, i) => {
    if (i % 2 === 0) { doc.setFillColor(243, 244, 246); doc.rect(14, y - 5, w - 28, 10, 'F') }
    doc.setTextColor(30, 30, 30)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
    doc.text(f.name || '', 16, y + 1)
    doc.text(fmt(f.amount), 100, y + 1)
    const ok = f.status === 'confirmed'
    doc.setTextColor(ok ? 46 : 198, ok ? 125 : 40, ok ? 50 : 40)
    doc.setFont('helvetica', 'bold')
    doc.text(ok ? 'Cleared' : 'Outstanding', 130, y + 1)
    doc.setTextColor(30, 30, 30); doc.setFont('helvetica', 'normal')
    doc.text(f.receipt_number || '—', 165, y + 1)
    y += 11
  })

  // Signature lines
  y += 16
  doc.setDrawColor(80, 80, 80)
  doc.line(14, y, 80, y)
  doc.line(w - 80, y, w - 14, y)
  doc.setFontSize(8); doc.setTextColor(100, 100, 100)
  doc.text("Bursar's Signature", 47, y + 5, { align: 'center' })
  doc.text('School Stamp', w - 47, y + 5, { align: 'center' })

  doc.save(`Clearance-${data.student_id}.pdf`)
}
