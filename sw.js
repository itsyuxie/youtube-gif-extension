const TENOR = 'https://tenor.com'
const YOUTUBE = 'https://www.youtube.com'
const REQUEST_TIMEOUT_MS = 10_000
const CACHE_LIFETIME_MS = 10 * 60 * 1000
const CACHE_LIMIT = 40
const RESULT_LIMIT = 50
const QUERY_LIMIT = 100

const NUMERIC_ID = /^\d{1,20}$/
const MEDIA_HOST = /^media\d*\.tenor\.com$/
const MEDIA_URL = /^https:\/\/media\d*\.tenor\.com\//
const MEDIA_KEY = /^[A-Za-z0-9_-]{16}$/
const PAGE_DATA = /<script\b[^>]*\bid="store-cache"[^>]*>([\s\S]*?)<\/script>/
const LAYOUT_CHANGED = 'GIF search is offline for now: the Tenor page layout has changed.'
const OFFLINE = 'Could not reach Tenor. Check your connection.'

class Problem extends Error {
  constructor(message, status = 0) {
    super(message)
    this.status = status
  }
}

chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.origin !== YOUTUBE) return false
  route(request).then(
    (gifs) => reply({ ok: true, gifs }),
    (error) => {
      if (!(error instanceof Problem)) console.warn('[YouTube GIF]', error)
      reply({ ok: false, error: error instanceof Problem ? error.message : OFFLINE })
    },
  )
  return true
})

async function route(request) {
  switch (request && request.kind) {
    case 'trending':
      return trending()
    case 'search':
      if (typeof request.query === 'string') return search(request.query)
      break
    case 'lookup':
      if (typeof request.link === 'string') return lookup(request.link)
      break
  }
  throw new Problem('Unknown request.')
}

const pages = new Map()

function loadPage(url) {
  const now = Date.now()
  const cached = pages.get(url)
  pages.delete(url)
  if (cached && now - cached.time < CACHE_LIFETIME_MS) {
    pages.set(url, cached)
    return cached.data
  }
  const entry = { time: now, data: fetchPageData(url) }
  pages.set(url, entry)
  entry.data.catch(() => {
    if (pages.get(url) === entry) pages.delete(url)
  })
  while (pages.size > CACHE_LIMIT) pages.delete(pages.keys().next().value)
  return entry.data
}

async function fetchPageData(url) {
  let response
  let html
  try {
    response = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (response.ok) html = await response.text()
  } catch (error) {
    throw new Problem(error && error.name === 'TimeoutError' ? 'Tenor is taking too long. Try again in a moment.' : OFFLINE)
  }
  if (response.status === 404) throw new Problem('Tenor has no GIF at that address.', 404)
  if (!response.ok) throw new Problem(`Tenor answered with HTTP ${response.status}.`, response.status)
  if (new URL(response.url).origin !== TENOR) throw new Problem('Tenor sent the request somewhere unexpected.')

  const match = PAGE_DATA.exec(html)
  if (!match) throw new Problem(LAYOUT_CHANGED)
  try {
    return JSON.parse(match[1])
  } catch (error) {
    throw new Problem(LAYOUT_CHANGED)
  }
}

const sizeOr = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)

function describe(item) {
  if (!item || typeof item !== 'object' || !NUMERIC_ID.test(String(item.id))) return null
  const flags = Array.isArray(item.flags) ? item.flags : []
  if (flags.includes('sticker') || flags.includes('static')) return null
  const formats = item.media_formats || {}
  const media = formats.tinygif || formats.tinywebp || formats.gif
  if (!media || typeof media.url !== 'string' || !MEDIA_URL.test(media.url)) return null
  const [width, height] = Array.isArray(media.dims) ? media.dims : []
  return {
    id: String(item.id),
    title: String(item.content_description || item.h1_title || '').trim().slice(0, 200) || 'Animated GIF',
    preview: media.url,
    width: sizeOr(width, 220),
    height: sizeOr(height, 124),
  }
}

function collect(items) {
  const ids = new Set()
  const gifs = []
  for (const item of Array.isArray(items) ? items : []) {
    const gif = describe(item)
    if (!gif || ids.has(gif.id)) continue
    ids.add(gif.id)
    gifs.push(gif)
    if (gifs.length === RESULT_LIMIT) break
  }
  return gifs
}

async function trending() {
  const data = await loadPage(`${TENOR}/`)
  return collect(data?.gifs?.featured?.results)
}

async function search(query) {
  const words = query.slice(0, QUERY_LIMIT).trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return trending()
  let data
  try {
    data = await loadPage(`${TENOR}/search/${words.map(encodeURIComponent).join('-')}-gifs`)
  } catch (error) {
    if (error instanceof Problem && error.status === 404) return []
    throw error
  }
  const searches = data?.universal?.search || {}
  const keys = Object.keys(searches)
  const phrase = words.join(' ')
  const key = keys.find((k) => k.startsWith(`${phrase}-`)) || keys[0]
  return collect(key && searches[key]?.results)
}

async function lookup(link) {
  const { pageUrl, id } = locate(link.trim())
  const data = await loadPage(pageUrl)
  const byId = data?.gifs?.byId || {}
  const entry = (id && byId[id]) || Object.values(byId)[0]
  const gifs = collect(entry?.results).slice(0, 1)
  if (!gifs.length) throw new Problem('No GIF found behind that link.')
  return gifs
}

const gifPage = (id) => ({ pageUrl: `${TENOR}/view/gif-${id}`, id })

function locate(text) {
  if (NUMERIC_ID.test(text)) return gifPage(text)

  let url
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch (error) {
    throw new Problem('That does not look like a Tenor link.')
  }

  if (MEDIA_HOST.test(url.hostname)) {
    const key = url.pathname.split('/').find((part) => MEDIA_KEY.test(part))
    if (!key) throw new Problem('That Tenor link is missing a GIF ID.')
    return gifPage(idFromMediaKey(key))
  }
  if (url.hostname === 'tenor.com' || url.hostname === 'www.tenor.com') {
    const tail = /-(\d{1,20})$/.exec(url.pathname)
    return { pageUrl: `${TENOR}${url.pathname}`, id: tail ? tail[1] : null }
  }
  throw new Problem('That does not look like a Tenor link.')
}

function idFromMediaKey(key) {
  const bytes = atob(`${key.slice(0, 11).replace(/-/g, '+').replace(/_/g, '/')}=`)
  let id = 0n
  for (let i = 0; i < 8; i++) id = (id << 8n) | BigInt(bytes.charCodeAt(i))
  if (id === 0n) throw new Problem('That Tenor link is missing a GIF ID.')
  return id.toString()
}
