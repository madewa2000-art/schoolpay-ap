async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('sp_token')
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  }
  const res = await fetch(`/api${path}`, { ...options, headers })
  if (res.status === 401) {
    localStorage.removeItem('sp_token')
    localStorage.removeItem('sp_user')
    localStorage.removeItem('sp_school')
    window.location.href = '/admin/login.html'
    return
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

async function apiUpload(path, formData) {
  const token = localStorage.getItem('sp_token')
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  const res = await fetch(`/api${path}`, { method: 'POST', headers, body: formData })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`)
  return data
}

async function apiDownload(path, filename) {
  const token = localStorage.getItem('sp_token')
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  const res = await fetch(`/api${path}`, { headers })
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Download failed') }
  const blob = await res.blob()
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
