(() => {
  'use strict'

  const COMMENT_AREA = 'ytd-comment-simplebox-renderer, ytd-comment-thread-renderer'
  const CHANNEL_POST_DIALOG = 'ytd-backstage-post-dialog-renderer'
  const PICKER_HEIGHT = 440
  const MARGIN = 8
  const TYPING_DELAY_MS = 300
  const READY_TIMEOUT_MS = 1500
  const SUBMIT_READY_MS = 1000
  const AUTO_SEND_WAIT_MS = 4000
  const CONFIRM_TIMEOUT_MS = 20000
  const GHOST_HEIGHTS = [96, 132, 110, 84, 140, 100]
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const GIF_BOX_PATH = 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm240-160h60v-240h-60v240Zm-160 0h80q17 0 28.5-11.5T400-400v-80h-60v60h-40v-120h100v-20q0-17-11.5-28.5T360-600h-80q-17 0-28.5 11.5T240-560v160q0 17 11.5 28.5T280-360Zm280 0h60v-80h80v-60h-80v-40h120v-60H560v240ZM200-200v-560 560Z'
  const SEARCH_PATH = 'M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z'

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const within = (promise, ms, fallback) => Promise.race([promise, pause(ms).then(() => fallback)])

  async function until(condition, timeoutMs, stepMs = 50) {
    const deadline = Date.now() + timeoutMs
    while (!condition() && Date.now() < deadline) await pause(stepMs)
    return condition()
  }

  function signal() {
    let fire
    const fired = new Promise((resolve) => { fire = resolve })
    return { fired, fire }
  }

  function makeTicket() {
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }

  function h(tag, props = {}, attrs = {}) {
    const node = Object.assign(document.createElement(tag), props)
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
    return node
  }

  function icon(path, className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 -960 960 960')
    svg.setAttribute('fill', 'currentColor')
    svg.setAttribute('aria-hidden', 'true')
    if (className) svg.setAttribute('class', className)
    const shape = document.createElementNS(SVG_NS, 'path')
    shape.setAttribute('d', path)
    svg.append(shape)
    return svg
  }

  const styles = new CSSStyleSheet()
  fetch(chrome.runtime.getURL('content.css'))
    .then((response) => response.text())
    .then((css) => styles.replace(css))
    .catch(() => {})

  function shadowOf(host) {
    const root = host.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [styles]
    return root
  }

  const listeners = new Map()

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return
    const message = event.data
    if (!message || message.ytgif !== 'page' || typeof message.ticket !== 'string') return
    const listener = listeners.get(message.ticket)
    if (listener) listener(message)
  })

  const tellPage = (message) => window.postMessage({ ytgif: 'extension', ...message }, location.origin)

  const isTenorLink = (text) => /^\d{6,20}$/.test(text) || /^(https?:\/\/)?([\w-]+\.)*tenor\.com\//i.test(text)

  async function requestGifs(text) {
    const request = !text ? { kind: 'trending' }
      : isTenorLink(text) ? { kind: 'lookup', link: text }
      : { kind: 'search', query: text }
    try {
      const reply = await chrome.runtime.sendMessage(request)
      return reply && typeof reply === 'object' ? reply : { ok: false, error: 'Could not reach Tenor. Check your connection.' }
    } catch (error) {
      return { ok: false, error: 'YouTube GIF was updated. Reload the page to keep using it.' }
    }
  }

  function moveCaret(editor, range) {
    editor.focus()
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }

  function insertToken(editor, token) {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    moveCaret(editor, range)
    let inserted = false
    try { inserted = document.execCommand('insertText', false, token) } catch (error) {}
    if (!inserted || !editor.textContent.includes(token)) {
      editor.append(token)
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: token }))
    }
  }

  function eraseToken(editor, token) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.data.indexOf(token)
      if (start === -1) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + token.length)
      moveCaret(editor, range)
      let erased = false
      try { erased = document.execCommand('delete', false) } catch (error) {}
      if (!erased || editor.textContent.includes(token)) {
        node.data = node.data.replace(token, '')
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
      }
      return
    }
  }

  async function sendGif(box, gif, onManualSend) {
    const editor = box && box.isConnected && box.querySelector('#contenteditable-root')
    const submit = box && box.querySelector('#submit-button button')
    if (!editor || !submit) return { ok: false, error: 'The comment box is gone. Open it again and retry.' }

    const ticket = makeTicket()
    const token = `{{ytgif:${gif.id}:${ticket}}}`
    const ready = signal()
    const done = signal()
    let sending = false
    listeners.set(ticket, (message) => {
      if (message.type === 'ready') ready.fire(true)
      else if (message.type === 'sending') sending = true
      else if (message.type === 'done') done.fire(message)
    })

    try {
      tellPage({ type: 'prepare', id: gif.id, ticket })
      if (!(await within(ready.fired, READY_TIMEOUT_MS, false))) {
        return { ok: false, error: 'The page helper did not start. Reload the page and retry.' }
      }

      insertToken(editor, token)
      await until(() => !submit.disabled, SUBMIT_READY_MS)
      submit.click()

      let outcome = await within(done.fired, AUTO_SEND_WAIT_MS, null)
      if (!outcome && !sending) {
        onManualSend((submit.getAttribute('aria-label') || submit.textContent || 'Comment').trim())
      }
      if (!outcome) outcome = await within(done.fired, CONFIRM_TIMEOUT_MS, null)
      if (outcome && outcome.ok) return { ok: true, error: null }

      tellPage({ type: 'cancel', ticket })
      if (editor.isConnected) eraseToken(editor, token)
      if (!outcome && sending) {
        return { ok: false, error: 'YouTube has not confirmed yet. Look for your comment before posting again.' }
      }
      return { ok: false, error: (outcome && outcome.error) || 'The GIF was not sent, and nothing was posted.' }
    } finally {
      listeners.delete(ticket)
    }
  }

  class Picker {
    constructor() {
      this.trigger = null
      this.box = null
      this.gifs = []
      this.query = null
      this.resultsCaption = ''
      this.requestId = 0
      this.typingTimer = 0
      this.sending = false

      this.host = h('div', { className: 'ytgif-picker' })
      this.root = shadowOf(this.host)

      const hint = 'Search GIFs or paste a Tenor link'
      this.input = h('input', { type: 'text', placeholder: hint, autocomplete: 'off', spellcheck: false }, { 'aria-label': hint })
      this.caption = h('div', { className: 'caption' }, { role: 'status', 'aria-live': 'polite' })
      this.results = h('div', { className: 'results' })
      this.panel = h('div', { className: 'picker' }, { role: 'dialog', 'aria-label': 'GIF picker' })
      const searchbar = h('div', { className: 'searchbar' })
      searchbar.append(icon(SEARCH_PATH, 'search-icon'), this.input)
      const credit = h('div', { className: 'credit', textContent: 'Powered by Tenor' })
      this.panel.append(searchbar, this.caption, this.results, credit)
      this.root.append(this.panel)

      this.input.addEventListener('input', () => {
        clearTimeout(this.typingTimer)
        this.typingTimer = setTimeout(() => this.refresh(), TYPING_DELAY_MS)
      })
      this.results.addEventListener('click', (event) => {
        const tile = event.target.closest('.gif')
        if (tile) this.pick(this.gifs[Number(tile.dataset.index)])
      })
    }

    get isOpen() {
      return this.host.isConnected
    }

    owns(event) {
      return this.isOpen && event.composedPath().includes(this.host)
    }

    toggle(trigger, box) {
      if (this.isOpen && this.trigger === trigger) this.close()
      else this.open(trigger, box)
    }

    open(trigger, box) {
      if (this.sending && trigger !== this.trigger) return
      this.close()
      this.trigger = trigger
      this.box = box
      trigger.setAttribute('aria-expanded', 'true')
      document.documentElement.append(this.host)
      this.position()
      this.input.focus()
      if (this.sending) return
      if (this.gifs.length && this.query === this.input.value.trim()) this.say(this.resultsCaption)
      else this.refresh()
    }

    close() {
      if (!this.isOpen) return
      clearTimeout(this.typingTimer)
      this.requestId++
      this.host.remove()
      this.trigger.setAttribute('aria-expanded', 'false')
      if (this.trigger.isConnected && !this.sending) this.trigger.focus()
    }

    position() {
      if (!this.isOpen) return
      if (!this.trigger.isConnected) {
        this.close()
        return
      }
      const anchor = this.trigger.getBoundingClientRect()
      const height = Math.min(PICKER_HEIGHT, innerHeight - 2 * MARGIN)
      this.panel.style.height = `${height}px`
      let top = anchor.top - height - MARGIN
      if (top < MARGIN) top = Math.min(anchor.bottom + MARGIN, innerHeight - height - MARGIN)
      const left = Math.min(anchor.left, innerWidth - this.panel.offsetWidth - MARGIN)
      this.host.style.top = `${Math.max(MARGIN, top)}px`
      this.host.style.left = `${Math.max(MARGIN, left)}px`
    }

    say(text, tone) {
      this.caption.textContent = text || ''
      if (tone) this.caption.dataset.tone = tone
      else delete this.caption.dataset.tone
    }

    setSending(sending) {
      this.sending = sending
      this.panel.toggleAttribute('data-busy', sending)
    }

    columns() {
      return [0, 1].map(() => ({ node: h('div', { className: 'column' }), height: 0 }))
    }

    showGhosts() {
      const columns = this.columns()
      GHOST_HEIGHTS.forEach((height, i) => {
        const ghost = h('div', { className: 'ghost' })
        ghost.style.height = `${height}px`
        columns[i % 2].node.append(ghost)
      })
      this.results.replaceChildren(...columns.map((c) => c.node))
      this.results.setAttribute('aria-busy', 'true')
    }

    async refresh() {
      clearTimeout(this.typingTimer)
      const text = this.input.value.trim()
      const requestId = ++this.requestId
      this.say('')
      this.showGhosts()
      const reply = await requestGifs(text)
      if (requestId !== this.requestId || !this.isOpen) return
      this.results.removeAttribute('aria-busy')
      if (!reply.ok || !Array.isArray(reply.gifs)) {
        this.show([], null, '')
        this.say(reply.error || 'Could not reach Tenor. Check your connection.', 'error')
        return
      }
      const caption = !reply.gifs.length ? 'Nothing matched. Try another word.' : text ? '' : 'Trending'
      this.show(reply.gifs, text, caption)
      this.say(caption)
    }

    show(gifs, query, caption) {
      this.gifs = gifs
      this.query = query
      this.resultsCaption = caption
      const columns = this.columns()
      gifs.forEach((gif, i) => {
        const tile = h('button', { type: 'button', className: 'gif', title: gif.title })
        tile.dataset.index = String(i)
        const image = h('img', {
          alt: gif.title,
          width: gif.width,
          height: gif.height,
          loading: 'lazy',
          decoding: 'async',
          referrerPolicy: 'no-referrer',
        })
        image.addEventListener('load', () => image.classList.add('shown'), { once: true })
        image.src = gif.preview
        tile.append(image)
        const column = columns[0].height <= columns[1].height ? columns[0] : columns[1]
        column.node.append(tile)
        column.height += gif.height / gif.width
      })
      this.results.replaceChildren(...columns.map((c) => c.node))
      this.results.scrollTop = 0
    }

    async pick(gif) {
      if (!gif || this.sending) return
      this.setSending(true)
      this.say('Sending your GIF…')
      let outcome
      try {
        outcome = await sendGif(this.box, gif, (label) => this.say(`Click ${label} to finish posting.`))
      } finally {
        this.setSending(false)
      }
      if (outcome.ok) this.close()
      else this.say(outcome.error, 'error')
    }

    onKey(event) {
      const active = this.root.activeElement
      const tile = active && active.classList.contains('gif') ? active : null
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          this.close()
          break
        case 'Enter':
          if (active !== this.input || this.sending) break
          event.preventDefault()
          if (this.query !== this.input.value.trim()) this.refresh()
          else if (this.gifs.length === 1) this.pick(this.gifs[0])
          else this.focus(this.results.querySelector('.gif'))
          break
        case 'ArrowDown':
          if (active === this.input) {
            event.preventDefault()
            this.focus(this.results.querySelector('.gif'))
          } else if (tile) {
            event.preventDefault()
            this.focus(tile.nextElementSibling)
          }
          break
        case 'ArrowUp':
          if (!tile) break
          event.preventDefault()
          if (tile.previousElementSibling) this.focus(tile.previousElementSibling)
          else this.input.focus()
          break
        case 'ArrowLeft':
        case 'ArrowRight':
          if (!tile) break
          event.preventDefault()
          this.focus(this.neighbour(tile, event.key === 'ArrowRight' ? 1 : -1))
          break
      }
    }

    focus(tile) {
      if (tile) tile.focus()
    }

    neighbour(tile, step) {
      const columns = [...this.results.children]
      const column = columns[columns.indexOf(tile.parentElement) + step]
      if (!column) return null
      const centre = (rect) => rect.top + rect.height / 2
      const target = centre(tile.getBoundingClientRect())
      let closest = null
      let gap = Infinity
      for (const candidate of column.children) {
        const distance = Math.abs(centre(candidate.getBoundingClientRect()) - target)
        if (distance < gap) [closest, gap] = [candidate, distance]
      }
      return closest
    }
  }

  let picker = null
  const usePicker = () => (picker ||= new Picker())

  function attachTrigger(box) {
    if (box.querySelector('.ytgif-button')) return
    if (!box.closest(COMMENT_AREA) || box.closest(CHANNEL_POST_DIALOG)) return
    const footer = box.querySelector('#footer')
    if (!footer) return
    const host = h('span', { className: 'ytgif-button' })
    const root = shadowOf(host)
    const trigger = h('button', { type: 'button', className: 'trigger', title: 'Insert GIF' }, {
      'aria-label': 'Insert GIF',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
    })
    trigger.append(icon(GIF_BOX_PATH))
    root.append(trigger)
    trigger.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      usePicker().toggle(trigger, box)
    })
    const emoji = footer.querySelector('#emoji-button')
    if (emoji && emoji.parentElement === footer) emoji.after(host)
    else footer.prepend(host)
  }

  let scanPending = false
  new MutationObserver(() => {
    if (scanPending) return
    scanPending = true
    requestAnimationFrame(() => {
      scanPending = false
      for (const box of document.querySelectorAll('ytd-commentbox')) attachTrigger(box)
    })
  }).observe(document.documentElement, { childList: true, subtree: true })

  const insidePicker = (event) => picker !== null && picker.owns(event)

  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(type, (event) => {
      if (!insidePicker(event)) return
      event.stopImmediatePropagation()
      if (type === 'keydown') picker.onKey(event)
    }, true)
  }
  window.addEventListener('wheel', (event) => {
    if (insidePicker(event)) event.stopImmediatePropagation()
  }, { capture: true, passive: true })

  window.addEventListener('pointerdown', (event) => {
    if (!picker || !picker.isOpen || picker.sending) return
    const path = event.composedPath()
    if (!path.includes(picker.host) && !path.includes(picker.trigger)) picker.close()
  }, true)

  let positionPending = false
  const schedulePosition = () => {
    if (!picker || !picker.isOpen || positionPending) return
    positionPending = true
    requestAnimationFrame(() => {
      positionPending = false
      picker.position()
    })
  }
  window.addEventListener('scroll', schedulePosition, { capture: true, passive: true })
  window.addEventListener('resize', schedulePosition, { passive: true })
  window.addEventListener('yt-navigate-start', () => {
    if (picker && !picker.sending) picker.close()
  })
})()
