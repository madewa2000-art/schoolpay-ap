import { v4 as uuidv4 } from 'uuid'

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

function pad(n) {
  return String(n).padStart(5, '0')
}

export function generateReference({ slug, schoolType, paymentTypeName, sequence }) {
  const year = new Date().getFullYear()
  const pre  = slugPrefix(slug)
  const st   = schoolTypeCode(schoolType)
  const tc   = typeCode(paymentTypeName)
  const seq  = pad(sequence ?? Math.floor(Math.random() * 99999))
  return `${pre}-${st}-${year}-${seq}-${tc}`
}

export function generateReceiptNumber({ slug, sequence }) {
  const year = new Date().getFullYear()
  const pre  = slugPrefix(slug)
  const seq  = pad(sequence ?? Math.floor(Math.random() * 99999))
  return `RCP-${pre}-${year}-${seq}`
}
