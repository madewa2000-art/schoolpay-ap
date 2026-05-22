import { randomBytes } from 'crypto'

const TYPE_CODES = {
  'Annual Dues':       'ANN',
  'School Fees':       'SCH',
  'Tuition':           'TUI',
  'Hostel Fee':        'HOS',
  'Exam Fee':          'EXM',
  'PTA Levy':          'PTA',
  'Development Levy':  'DEV',
  'Library Fee':       'LIB',
  'Acceptance Fee':    'ACC',
  'Lab Fee':           'LAB',
}

function slugPrefix(slug) {
  return slug.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toUpperCase()
}

function typeCode(typeName) {
  return TYPE_CODES[typeName] || typeName.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase()
}

function schoolTypeCode(type) {
  return { primary: 'PRI', secondary: 'SEC', university: 'UNI' }[type] || 'SCH'
}

// 6 random bytes = 48 bits ≈ 281 trillion combinations.
// Replaces the previous SELECT COUNT(*)+1 sequence which was a race condition
// under concurrent requests — two simultaneous initiations could generate the
// same reference, causing Paystack to reject the second transaction silently.
function randomHex() {
  return randomBytes(6).toString('hex').toUpperCase()
}

export function generateReference({ slug, schoolType, paymentTypeName }) {
  const year = new Date().getFullYear()
  const pre  = slugPrefix(slug)
  const st   = schoolTypeCode(schoolType)
  const tc   = typeCode(paymentTypeName)
  return `${pre}-${st}-${year}-${randomHex()}-${tc}`
}

export function generateReceiptNumber({ slug }) {
  const year = new Date().getFullYear()
  const pre  = slugPrefix(slug)
  return `RCP-${pre}-${year}-${randomHex()}`
}
