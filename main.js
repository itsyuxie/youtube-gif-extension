(() => {
  'use strict'

  const COMMENT_API = /\/youtubei\/v1\/(?:comment|backstage)\//
  const CREATE_API = /\/youtubei\/v1\/comment\/create_comment(?:_reply)?(?:[?#]|$)/
  const TOKEN = /\{\{ytgif:(\d{1,20}):([a-z0-9]{8,32})\}\}/
  const NUMERIC_ID = /^\d{1,20}$/
  const TICKET = /^[a-z0-9]{8,32}$/
  const TICKET_LIFETIME_MS = 3 * 60 * 1000

  const tickets = new Map()

  function redeem(ticket) {
    const entry = tickets.get(ticket)
    tickets.delete(ticket)
    return entry && entry.expires >= Date.now() ? entry : null
  }

  function dropExpired() {
    const now = Date.now()
    for (const [ticket, entry] of tickets) if (entry.expires < now) tickets.delete(ticket)
  }

  const tell = (message) => window.postMessage({ ytgif: 'page', ...message }, location.origin)

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return
    const message = event.data
    if (!message || message.ytgif !== 'extension' || typeof message.ticket !== 'string' || !TICKET.test(message.ticket)) return
    if (message.type === 'prepare' && typeof message.id === 'string' && NUMERIC_ID.test(message.id)) {
      dropExpired()
      tickets.set(message.ticket, { id: message.id, expires: Date.now() + TICKET_LIFETIME_MS })
      tell({ type: 'ready', ticket: message.ticket })
    } else if (message.type === 'cancel') {
      tickets.delete(message.ticket)
    }
  })

  window.fetch = new Proxy(window.fetch, {
    apply(target, thisArg, args) {
      const url = urlOf(args[0])
      return COMMENT_API.test(url) ? intercept(target, thisArg, args, url) : Reflect.apply(target, thisArg, args)
    },
  })

  function urlOf(input) {
    try {
      return input instanceof Request ? input.url : String(input)
    } catch (error) {
      return ''
    }
  }

  async function readPayload(input, init) {
    const isRequest = input instanceof Request
    const headers = new Headers((init && init.headers) || (isRequest ? input.headers : {}))
    let bytes
    if (init && init.body != null) bytes = await new Response(init.body).arrayBuffer()
    else if (isRequest) bytes = await input.clone().arrayBuffer()
    else return null
    const text = /\bgzip\b/i.test(headers.get('content-encoding') || '')
      ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(bytes)
    return { headers, text }
  }

  function parseObject(text) {
    try {
      const value = JSON.parse(text)
      return value && typeof value === 'object' ? value : null
    } catch (error) {
      return null
    }
  }

  async function intercept(target, thisArg, args, url) {
    const [input, init] = args
    let payload = null
    try {
      payload = await readPayload(input, init)
    } catch (error) {}

    const found = payload && TOKEN.exec(payload.text)
    if (!found) return Reflect.apply(target, thisArg, args)

    const [token, id, ticket] = found
    const entry = redeem(ticket)
    const body = parseObject(payload.text)
    const text = body && typeof body.commentText === 'string' ? body.commentText.trim() : ''
    const caption = text.endsWith(token) ? text.slice(0, -token.length).trim() : null
    const allowed = body && CREATE_API.test(url)
      && caption !== null && !TOKEN.test(caption)
      && entry && entry.id === id
    if (!allowed) {
      tell({ type: 'done', ticket, ok: false, error: 'This comment box cannot post GIFs, or the GIF expired. Nothing was posted.' })
      throw new TypeError('YouTube GIF stopped an unconfirmed GIF token')
    }

    tell({ type: 'sending', ticket })
    if (caption) body.commentText = caption
    else delete body.commentText
    body.tenorId = id
    const headers = payload.headers
    headers.delete('content-encoding')

    let response
    try {
      const request = new Request(input, { ...init, body: JSON.stringify(body), headers })
      response = await Reflect.apply(target, thisArg, [request])
    } catch (error) {
      tell({ type: 'done', ticket, ok: false, error: 'Could not send the comment. Nothing was posted.' })
      throw error
    }
    tell({ type: 'done', ticket, ...(await verdict(response)) })
    return response
  }

  async function verdict(response) {
    const httpProblem = `YouTube answered with HTTP ${response.status}.`
    let json
    try {
      json = await response.clone().json()
    } catch (error) {
      return { ok: response.ok, error: response.ok ? null : httpProblem }
    }
    const action = json && json.actionResult
    if (response.ok && action && action.status === 'STATUS_SUCCEEDED') return { ok: true, error: null }
    const runs = (action && action.feedbackText && action.feedbackText.runs) || []
    const feedback = Array.isArray(runs) ? runs.map((run) => (run && run.text) || '').join('') : ''
    return { ok: false, error: (json && json.error && json.error.message) || feedback || httpProblem }
  }
})()
