import { useSyncExternalStore } from 'react'

const MAX_POINTS = 120
const EMPTY = []

let ws = null
let wsToken = ''
let reconnectTimer = null
let shouldReconnect = true

const statsById = new Map() // id -> Array<sample>
const listenersById = new Map() // id -> Set<fn>

function notify(id) {
  const set = listenersById.get(id)
  if (!set || set.size === 0) return
  for (const fn of Array.from(set)) {
    try { fn() } catch {}
  }
}

function setStats(id, sample) {
  if (!id) return
  const prev = statsById.get(id) || EMPTY
  const next = [...prev.slice(-MAX_POINTS + 1), sample]
  statsById.set(id, next)
  notify(id)
}

export function reconcileContainerStats(containerIds) {
  const keep = new Set((Array.isArray(containerIds) ? containerIds : []).map((id) => String(id || '')).filter(Boolean))
  for (const id of Array.from(statsById.keys())) {
    if (keep.has(id)) continue
    statsById.delete(id)
    notify(id)
  }
}

function handleMessage(raw) {
  let msg
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
  } catch {
    return
  }

  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'init' && Array.isArray(msg.items)) {
    for (const item of msg.items) {
      const id = String(item?.id || '')
      if (!id) continue
      setStats(id, item)
    }
    return
  }

  if (msg.type === 'stats') {
    const id = String(msg?.id || '')
    if (!id) return
    // Store the sample without `type` to keep consumers simple.
    // The backend includes `id` + metric fields.
    const { type, ...rest } = msg
    setStats(id, rest)
    return
  }

  // Back-compat: accept a raw sample object as long as it contains an id.
  if (typeof msg.id === 'string' && msg.id) {
    setStats(msg.id, msg)
  }
}

function scheduleReconnect() {
  if (!shouldReconnect) return
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (wsToken) connectContainerStats(wsToken)
  }, 1000)
}

export function connectContainerStats(token) {
  const nextToken = String(token || '').trim()
  if (!nextToken) return
  if (ws && ws.readyState === WebSocket.OPEN && wsToken === nextToken) return

  wsToken = nextToken
  shouldReconnect = true

  try { ws?.close() } catch {}
  ws = null

  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const url = new URL('/ws/containers/stats/stream', window.location.origin)
  url.searchParams.set('token', wsToken)

  ws = new WebSocket(`${proto}://${window.location.host}${url.pathname}${url.search}`)
  ws.onmessage = (ev) => handleMessage(ev.data)
  ws.onclose = () => scheduleReconnect()
  ws.onerror = () => {}
}

export function disconnectContainerStats() {
  shouldReconnect = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  wsToken = ''
  try { ws?.close() } catch {}
  ws = null
}

function subscribe(id, cb) {
  const key = String(id || '')
  if (!key) return () => {}
  let set = listenersById.get(key)
  if (!set) {
    set = new Set()
    listenersById.set(key, set)
  }
  set.add(cb)
  return () => {
    const bucket = listenersById.get(key)
    if (!bucket) return
    bucket.delete(cb)
    if (bucket.size === 0) listenersById.delete(key)
  }
}

function getSnapshot(id) {
  const key = String(id || '')
  return statsById.get(key) || EMPTY
}

export function useContainerStats(containerId) {
  return useSyncExternalStore(
    (cb) => subscribe(containerId, cb),
    () => getSnapshot(containerId),
    () => EMPTY
  )
}
