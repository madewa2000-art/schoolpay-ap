import { pool } from '../db/index.js'

// Attaches req.school from the :slug URL param.
// Used on all /s/:slug/* routes so every handler gets the school context.
export async function attachSchool(req, res, next) {
  const { slug } = req.params
  if (!slug) return res.status(400).json({ error: 'School slug required' })

  try {
    const { rows } = await pool.query(
      'SELECT * FROM schools WHERE slug = $1 AND active = true',
      [slug]
    )
    if (!rows.length) return res.status(404).json({ error: 'School not found' })
    req.school = rows[0]
    next()
  } catch (err) {
    next(err)
  }
}
