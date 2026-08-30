// Fee categories.
//
// A category is a label typed on a fee type ("Levies", "Hostel"), not a table
// of its own — schools set them up by typing, and fees group by matching text.
// The URL form is stored alongside it so the per-category payment link
// (/pay/<school>/<category>) resolves with an index lookup.

export const DEFAULT_CATEGORY = 'General'

export function categorySlug(name) {
  return String(name || DEFAULT_CATEGORY)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'general'
}

// Normalises what the admin typed: trims, collapses whitespace, and falls back
// to the default so a fee is never left uncategorised and therefore unreachable
// from any category link.
export function normalizeCategory(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim()
  const label = clean || DEFAULT_CATEGORY
  return { category: label.slice(0, 80), category_slug: categorySlug(label) }
}
