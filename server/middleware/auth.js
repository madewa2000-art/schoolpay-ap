import jwt from 'jsonwebtoken'

export function verifyToken(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' })
  }
  try {
    req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }
    next()
  }
}

// Ensures school_admin/bursar/accountant can only touch their own school
export function requireSchoolMatch(req, res, next) {
  if (req.user.role === 'super_admin') return next()
  const schoolId = req.school?.id || req.params.schoolId
  if (req.user.school_id !== schoolId) {
    return res.status(403).json({ error: 'Access denied to this school' })
  }
  next()
}
