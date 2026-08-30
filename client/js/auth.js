function getToken()  { return localStorage.getItem('sp_token') }
function getUser()   { try { return JSON.parse(localStorage.getItem('sp_user') || 'null') } catch { return null } }
function getSchool() { try { return JSON.parse(localStorage.getItem('sp_school') || 'null') } catch { return null } }

function setAuth({ token, user, school }) {
  localStorage.setItem('sp_token', token)
  localStorage.setItem('sp_user', JSON.stringify(user))
  if (school) localStorage.setItem('sp_school', JSON.stringify(school))
}

function clearAuth() {
  localStorage.removeItem('sp_token')
  localStorage.removeItem('sp_user')
  localStorage.removeItem('sp_school')
}

function requireAuth(roles) {
  const token = getToken()
  const user  = getUser()
  if (!token || !user) { window.location.href = '/admin/login.html'; return null }
  if (roles && !roles.includes(user.role)) { window.location.href = '/admin/login.html'; return null }
  return user
}

function requireSuperAuth() {
  const token = getToken()
  const user  = getUser()
  if (!token || !user || user.role !== 'super_admin') { window.location.href = '/super/login.html'; return null }
  return user
}

// Portal: resolves the school from either address form —
//   /portal/index.html?school=st-marys        (the original)
//   /pay/st-marys/levies                      (shareable payment link)
// falling back to the last school seen in this tab.
function getPortalSlug() {
  const fromPath = window.location.pathname.match(/^\/pay\/([^/]+)/)
  const params   = new URLSearchParams(window.location.search)
  const slug     = (fromPath && decodeURIComponent(fromPath[1]))
                || params.get('school')
                || sessionStorage.getItem('sp_portal_school')
  if (slug) sessionStorage.setItem('sp_portal_school', slug)
  return slug
}

// The category half of a payment link, if the payer arrived through one.
// Deliberately not cached: leaving a category link should not narrow the fee
// list on a later visit to the full portal.
function getPortalCategory() {
  const fromPath = window.location.pathname.match(/^\/pay\/[^/]+\/([^/]+)/)
  if (fromPath) return decodeURIComponent(fromPath[1])
  return new URLSearchParams(window.location.search).get('category') || null
}
