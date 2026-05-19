// ─── HTML escaping — always use this when inserting user data into innerHTML ──
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  let c = document.getElementById('sp-toast-container')
  if (!c) { c = document.createElement('div'); c.id = 'sp-toast-container'; document.body.appendChild(c) }
  const el   = document.createElement('div')
  el.className = `sp-toast ${type}`
  const span = document.createElement('span')
  span.textContent = msg    // textContent prevents XSS from API error messages
  el.appendChild(span)
  c.appendChild(el)
  setTimeout(() => el.remove(), 4500)
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function formatNaira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })
}
function formatDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function badgeHTML(status) {
  const cls = {
    confirmed:'badge-confirmed', approved:'badge-approved', resolved:'badge-resolved',
    pending:'badge-pending', failed:'badge-failed', rejected:'badge-rejected',
    refunded:'badge-refunded', open:'badge-open', in_review:'badge-in_review',
  }[status] || 'badge-pending'
  return `<span class="badge ${cls}">${(status || '').replace('_', ' ')}</span>`
}

// ─── Button loading state ─────────────────────────────────────────────────────
function btnLoading(btn, loading, label) {
  if (loading) { btn.disabled = true; btn._label = btn.innerHTML; btn.innerHTML = `<span class="sp-spinner"></span>` }
  else { btn.disabled = false; btn.innerHTML = label || btn._label || 'Submit' }
}

// ─── Admin sidebar builder ────────────────────────────────────────────────────
function buildAdminSidebar({ activePage, school, user }) {
  const isSuper = user?.role === 'super_admin'
  const nav = isSuper
    ? [
        { page: 'dashboard', label: 'Dashboard', href: '/super/dashboard.html' },
      ]
    : [
        { page: 'dashboard',  label: 'Dashboard',       href: '/admin/dashboard.html'  },
        { page: 'payments',   label: 'Payment Tracker', href: '/admin/payments.html'   },
        { page: 'fees',       label: 'Fee Types',       href: '/admin/fees.html'       },
        { page: 'documents',  label: 'Bank Documents',  href: '/admin/documents.html'  },
        { page: 'complaints', label: 'Complaints',      href: '/admin/complaints.html' },
        { page: 'reports',    label: 'Reports',         href: '/admin/reports.html'    },
        ...(user?.role === 'school_admin'
          ? [{ page: 'staff', label: 'Staff', href: '/admin/staff.html' }]
          : []),
      ]

  const navHTML = nav.map(item => `
    <a href="${item.href}" class="sp-nav-item${item.page === activePage ? ' active' : ''}">
      <span class="sp-nav-label">${item.label}</span>
    </a>`).join('')

  const schoolBlock = school && !isSuper ? `
    <div class="sp-sidebar-school">
      <p class="sp-sidebar-school-name">${esc(school.name)}</p>
      <span class="sp-sidebar-school-badge">${esc(school.type)}</span>
    </div>` : ''

  const logoutFn = isSuper ? 'doSuperLogout()' : 'doLogout()'

  return `
    <aside class="sp-sidebar" id="sp-sidebar">
      <div class="sp-sidebar-header">
        <div class="sp-sidebar-brand">
          <span class="sp-sidebar-wordmark">SchoolPay</span>
        </div>
        <button class="sp-sidebar-toggle" onclick="toggleSidebar()">&#8592;</button>
      </div>
      ${schoolBlock}
      <nav class="sp-sidebar-nav">${navHTML}</nav>
      <div class="sp-sidebar-footer">
        <div class="sp-sidebar-user">
          <p class="sp-sidebar-user-name">${esc(user?.name || '')}</p>
          <p class="sp-sidebar-user-role">${esc((user?.role || '').replace('_', ' '))}</p>
        </div>
        <button class="sp-logout-btn" onclick="${logoutFn}">Logout</button>
      </div>
    </aside>`
}

function initAdminPage({ activePage, titleText }) {
  const user   = getUser()
  const school = getSchool()
  document.getElementById('sp-sidebar-container').innerHTML =
    buildAdminSidebar({ activePage, school, user })

  // Overlay backdrop for mobile drawer
  if (!document.getElementById('sp-sidebar-overlay')) {
    const overlay = document.createElement('div')
    overlay.id = 'sp-sidebar-overlay'
    overlay.className = 'sp-sidebar-overlay'
    overlay.addEventListener('click', closeMobileSidebar)
    document.body.appendChild(overlay)
  }

  // Hamburger button injected into topbar for mobile
  const topbar = document.querySelector('.sp-topbar')
  if (topbar && !topbar.querySelector('.sp-mobile-menu-btn')) {
    const btn = document.createElement('button')
    btn.className = 'sp-mobile-menu-btn'
    btn.setAttribute('aria-label', 'Open menu')
    btn.innerHTML = '&#9776;'
    btn.addEventListener('click', toggleSidebar)
    topbar.insertBefore(btn, topbar.firstChild)
  }


  const t = document.getElementById('sp-page-title')
  if (t) t.textContent = titleText || activePage
  const s = document.getElementById('sp-topbar-school')
  if (s && school) s.textContent = school.name

  // Close drawer when a nav link is tapped on mobile
  document.querySelectorAll('.sp-nav-item').forEach(a => {
    a.addEventListener('click', () => { if (window.innerWidth <= 768) closeMobileSidebar() })
  })
}

function openMobileSidebar() {
  const sidebar = document.getElementById('sp-sidebar')
  const overlay = document.getElementById('sp-sidebar-overlay')
  if (sidebar) sidebar.classList.add('mobile-open')
  if (overlay) overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
}

function closeMobileSidebar() {
  const sidebar = document.getElementById('sp-sidebar')
  const overlay = document.getElementById('sp-sidebar-overlay')
  if (sidebar) sidebar.classList.remove('mobile-open')
  if (overlay) overlay.classList.remove('active')
  document.body.style.overflow = ''
}

function toggleSidebar() {
  if (window.innerWidth <= 768) {
    const sidebar = document.getElementById('sp-sidebar')
    sidebar && sidebar.classList.contains('mobile-open') ? closeMobileSidebar() : openMobileSidebar()
  } else {
    document.getElementById('sp-sidebar').classList.toggle('collapsed')
    document.getElementById('sp-admin-main').classList.toggle('collapsed')
  }
}

// Reset mobile sidebar state on resize to desktop
window.addEventListener('resize', () => { if (window.innerWidth > 768) closeMobileSidebar() })

function doLogout()      { clearAuth(); window.location.href = '/admin/login.html' }
function doSuperLogout() { clearAuth(); window.location.href = '/super/login.html' }

// ─── Portal nav builder ───────────────────────────────────────────────────────
function buildPortalNav(school, activePage) {
  const slug = school?.slug || getPortalSlug() || ''
  const links = [
    { page: 'index',     label: 'Make Payment',  href: `/portal/index.html?school=${slug}`     },
    { page: 'history',   label: 'My Payments',   href: `/portal/history.html?school=${slug}`   },
    { page: 'upload',    label: 'Upload Proof',  href: `/portal/upload.html?school=${slug}`    },
    { page: 'clearance', label: 'Clearance',     href: `/portal/clearance.html?school=${slug}` },
    { page: 'complaint', label: 'Complaints',    href: `/portal/complaint.html?school=${slug}` },
  ]
  return links.map(l =>
    `<a href="${l.href}" class="${l.page === activePage ? 'active' : ''}">${l.label}</a>`
  ).join('')
}

function initPortalNav(school, activePage) {
  const linksHTML = buildPortalNav(school, activePage)
  const el = document.getElementById('sp-portal-nav-links')
  if (el) el.innerHTML = linksHTML

  // Inject mobile hamburger + dropdown once per page
  const nav = document.querySelector('.sp-portal-nav')
  if (nav && !nav.querySelector('.sp-portal-mobile-toggle')) {
    const btn = document.createElement('button')
    btn.className = 'sp-portal-mobile-toggle'
    btn.setAttribute('aria-label', 'Open navigation')
    btn.innerHTML = '&#9776;'
    nav.appendChild(btn)

    const mobileNav = document.createElement('div')
    mobileNav.className = 'sp-portal-mobile-nav'
    mobileNav.innerHTML = linksHTML
    nav.insertAdjacentElement('afterend', mobileNav)

    btn.addEventListener('click', () => {
      const open = mobileNav.classList.toggle('open')
      btn.innerHTML = open ? '&#10005;' : '&#9776;'
    })
    mobileNav.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        mobileNav.classList.remove('open')
        btn.innerHTML = '&#9776;'
      })
    })
  }

  const nameEl = document.getElementById('sp-portal-school-name')
  if (nameEl && school) nameEl.textContent = school.name
}
