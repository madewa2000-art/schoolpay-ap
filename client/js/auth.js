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

// Portal: gets school slug from ?school= URL param, caches it in sessionStorage
function getPortalSlug() {
  const params = new URLSearchParams(window.location.search)
  const slug   = params.get('school') || sessionStorage.getItem('sp_portal_school')
  if (slug) sessionStorage.setItem('sp_portal_school', slug)
  return slug
}
