import { useEffect, useMemo, useState } from 'react'
// No external API helper; inline fetch for simplicity
// Simplified UI: inline container cards with actions and stats

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token') || '')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [containers, setContainers] = useState([])
  const [agg, setAgg] = useState(null)
  const [aggHist, setAggHist] = useState({ cpu: [], mem: [], rx: [], tx: [], r: [], w: [] })
  const [broadcast, setBroadcast] = useState({ action: '', at: 0 })
  const [globalPhase, setGlobalPhase] = useState('') // '', 'start', 'restart', 'stop'
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => { if (token) localStorage.setItem('token', token) }, [token])

  const login = async () => {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
    if (res.ok) { const d = await res.json(); setToken(d.token); window.location.reload() } else { alert('Invalid password') }
  }
  const logout = () => { setToken(''); localStorage.removeItem('token'); window.location.reload() }

  const loadContainers = async () => {
    setError(''); setLoading(true)
    try {
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (token) headers.set('Authorization', `Bearer ${token}`)
      const r = await fetch('/api/containers', { headers })
      if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); return }
      if (!r.ok) throw new Error(await r.text().catch(()=>`HTTP ${r.status}`))
      const d = await r.json()
      setContainers(d.items || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally { setLoading(false) }
  }
  useEffect(() => { if (token) void loadContainers() }, [token])
  useEffect(() => {
    if (!token) return
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = new URL('/ws/containers/stream', window.location.origin)
    url.searchParams.set('token', token)
    const ws = new WebSocket(`${proto}://${window.location.host}${url.pathname}${url.search}`)
    ws.onmessage = (ev) => { try { const d = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); if (Array.isArray(d.items)) setContainers(d.items) } catch {} }
    ws.onerror = () => {}
    return () => { try { ws.close() } catch {} }
  }, [token])

  useEffect(() => {
    if (!token) return
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = new URL('/ws/containers/all/stats', window.location.origin)
    url.searchParams.set('token', token)
    const ws = new WebSocket(`${proto}://${window.location.host}${url.pathname}${url.search}`)
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data))
        setAgg(d)
        setAggHist(prev => ({
          cpu: [...prev.cpu.slice(-39), d.cpuPercent || 0],
          mem: [...prev.mem.slice(-39), d.memUsage || 0],
          rx:  [...prev.rx.slice(-39),  d.rxBytes || 0],
          tx:  [...prev.tx.slice(-39),  d.txBytes || 0],
          r:   [...prev.r.slice(-39),   d.ioRead || 0],
          w:   [...prev.w.slice(-39),   d.ioWrite || 0],
        }))
      } catch {}
    }
    ws.onerror = () => {}
    return () => { try { ws.close() } catch {} }
  }, [token])

  if (!token) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b0f14', color: '#e5e7eb' }}>
        <div style={{ background: '#151a21', padding: 24, borderRadius: 12, width: 'min(92vw, 420px)' }}>
          <h1 style={{ marginTop: 0, marginBottom: 16, fontSize: 22 }}>DockerDash</h1>
          <label style={{ display: 'block', marginBottom: 8, color: '#9aa4b2' }}>Password</label>
          <div style={{ display: 'grid', gap: 12 }}>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoFocus placeholder="Enter password" style={{ padding: '12px 12px', borderRadius: 8, border: '1px solid #2a2f36', background: '#0f141a', color: '#e5e7eb' }} />
            <button type="button" onClick={login} style={{ padding: '12px 12px', borderRadius: 8, border: 'none', background: '#2563eb', color: 'white', cursor: 'pointer' }}>Login</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0b0f14', color: '#e5e7eb' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #1f2530' }}>
        <div style={{ fontWeight: 600 }}>DockerDash</div>
        <div>
          <button onClick={logout} style={{ background: 'transparent', color: '#9aa4b2', border: '1px solid #2a2f36', padding: '6px 10px', borderRadius: 8, cursor: 'pointer' }}>Logout</button>
        </div>
      </header>
      <main style={{ padding: 0 }}>
        {error && <div style={{ background: '#241c1c', border: '1px solid #3b1e1e', color: '#fca5a5', borderRadius: 12, padding: 12, marginBottom: 16 }}>{error}</div>}
        {loading && !error && <div style={{ color: '#9aa4b2', marginBottom: 16 }}>Loading containers…</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16, padding: 16 }}>
          <AllInline token={token} agg={agg} hist={aggHist} containers={containers}
            onBroadcast={(action)=> setBroadcast({ action, at: Date.now() })}
            onPhaseChange={(type, active) => setGlobalPhase(active ? type : '')}
          />
          {containers.map(c => (
            <ContainerInline key={c.id} container={c} token={token} broadcast={broadcast} globalPhase={globalPhase} />
          ))}
          {containers.length === 0 && !error && (
            <div style={{ color: '#9aa4b2' }}>No containers found.</div>
          )}
        </div>
      </main>
      {/* Modal removed */}
    </div>
  )
}

function ContainerInline({ container, token, broadcast, globalPhase }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const uptime = useMemo(() => {
    const isRunning = container.state === 'running'
    const ref = isRunning ? container.startedAt : container.finishedAt
    if (!ref) return undefined
    const t = new Date(ref).getTime()
    if (Number.isNaN(t)) return undefined
    const diff = Math.max(0, Math.floor((now - t) / 1000))
    const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60), s = diff % 60
    const parts = []; if (h) parts.push(`${h}h`); if (m || h) parts.push(`${m}m`); parts.push(`${s}s`)
    return parts.join(' ')
  }, [now, container.startedAt, container.finishedAt, container.state])
  const [stats, setStats] = useState([])
  const [inspect, setInspect] = useState(null)
  const [busy, setBusy] = useState('')
  const [phase, setPhase] = useState('idle') // 'idle'|'starting'|'restarting'|'stopping'
  useEffect(() => {
    if (!broadcast || !broadcast.action) return
    const lowerName = (container.name || '').toLowerCase()
    const lowerImage = (container.image || '').toLowerCase()
    if (lowerName.includes('dockerdash') || lowerImage.includes('dockerdash')) return
    setMsg(broadcast.action.charAt(0).toUpperCase()+broadcast.action.slice(1)+' issued')
    if (broadcast.action === 'start') setPhase('starting')
    if (broadcast.action === 'restart') setPhase('restarting')
    if (broadcast.action === 'stop') setPhase('stopping')
    setTimeout(()=> setMsg(''), 1500)
    setTimeout(()=> setPhase('idle'), 3000)
  }, [broadcast])
  const [msg, setMsg] = useState('')
  useEffect(() => {
    // live via WebSocket
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = new URL(`/ws/containers/${container.id}/stats`, window.location.origin)
    url.searchParams.set('token', token)
    const ws = new WebSocket(`${proto}://${window.location.host}${url.pathname}${url.search}`)
    ws.onmessage = (ev) => { try { const s = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); setStats(prev => [...prev.slice(-119), s]) } catch {} }
    ws.onerror = () => {}
    return () => { try { ws.close() } catch {} }
  }, [container.id, token])

  useEffect(() => {
    fetch(`/api/containers/${container.id}/inspect`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setInspect).catch(() => setInspect(null))
  }, [container.id, token])

  const action = async (type) => {
    if (busy) return
    setBusy(type)
    if (type==='start') setPhase('starting')
    if (type==='restart') setPhase('restarting')
    if (type==='stop') setPhase('stopping')
    try {
      const headers = new Headers()
      if (token) headers.set('Authorization', `Bearer ${token}`)
      const r = await fetch(`/api/containers/${container.id}/${type}`, { method: 'POST', headers })
      if (!r.ok) throw new Error(await r.text().catch(()=> 'request failed'))
      setMsg(type==='pull' ? 'Rebuild started' : type.charAt(0).toUpperCase()+type.slice(1)+' OK')
      setTimeout(()=> setMsg(''), 2000)
    } catch (e) {
      setMsg(type==='pull' ? 'Rebuild failed (local image or no registry?)' : 'Action failed')
      setTimeout(()=> setMsg(''), 2500)
    } finally {
      setBusy('')
      setTimeout(()=> setPhase('idle'), 3000)
    }
  }

  const cpuSeries = stats.map(s => s.cpuPercent || 0)
  const memSeries = stats.map(s => s.memUsage || 0)
  const rxSeries = stats.map(s => (s.rxBytes || 0))
  const txSeries = stats.map(s => (s.txBytes || 0))
  const ioReadSeries = stats.map(s => (s.ioRead || 0))
  const ioWriteSeries = stats.map(s => (s.ioWrite || 0))

  const isRunning = container.state === 'running'
  const globalDisableStart = globalPhase === 'start'
  const globalDisableRestart = globalPhase === 'restart'
  const globalDisableStop = globalPhase === 'stop'
  const killMode = phase === 'starting' || phase === 'restarting'
  const portsObj = (inspect && inspect.NetworkSettings && inspect.NetworkSettings.Ports) || {}
  const hostPortsSet = new Set()
  Object.entries(portsObj).forEach(([containerPort, arr]) => {
    if (Array.isArray(arr)) arr.forEach(m => { if (m && m.HostPort) hostPortsSet.add(m.HostPort) })
  })
  const portsList = Array.from(hostPortsSet)
  const lowerName = (container.name || '').toLowerCase()
  const lowerImage = (container.image || '').toLowerCase()
  const disableRebuild = lowerName.includes('dockerdash') || lowerImage.includes('dockerdash')

  return (
    <div style={{ background: '#151a21', border: '1px solid #1f2530', borderRadius: 12, padding: 16, overflow: 'hidden' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{container.name}</div>
      <div style={{ color: '#9aa4b2', fontSize: 12, marginBottom: 8 }}>
        {container.image}
        {((container.hostPorts && container.hostPorts.length>0) || portsList.length>0) && (
          <>
            {' '}|{' '}Ports: {(container.hostPorts && container.hostPorts.length? container.hostPorts : portsList).join(', ')}
          </>
        )}
      </div>
      <div style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ color: container.state === 'running' ? '#22c55e' : '#f59e0b' }}>{container.state}</span>
        {uptime && <span style={{ color: '#9aa4b2' }}>• {container.state==='running'?'up':'down'} {uptime}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, width: '100%', flexWrap: 'wrap' }}>
        <button onClick={() => action('start')} disabled={busy!=='' || isRunning || globalDisableStart || phase==='restarting' || phase==='stopping'} style={{...actionBtnStyle, opacity: (busy!=='' || isRunning || globalDisableStart || phase==='restarting' || phase==='stopping')?0.6:1, cursor: (busy!=='' || isRunning || globalDisableStart || phase==='restarting' || phase==='stopping')?'not-allowed':'pointer'}}>Start</button>
        <button onClick={() => action('restart')} disabled={busy!=='' || !isRunning || globalDisableRestart || phase==='starting' || phase==='stopping'} style={{...actionBtnStyle, opacity: (busy!=='' || !isRunning || globalDisableRestart || phase==='starting' || phase==='stopping')?0.6:1, cursor: (busy!=='' || !isRunning || globalDisableRestart || phase==='starting' || phase==='stopping')?'not-allowed':'pointer'}}>Restart</button>
        <button onClick={() => action(killMode ? 'kill' : 'stop')} disabled={busy!=='' || (globalDisableStop) || (phase==='stopping') || (!isRunning && !killMode)} style={{...dangerBtnStyle, opacity: (busy!=='' || globalDisableStop || phase==='stopping' || (!isRunning && !killMode))?0.6:1, cursor: (busy!=='' || globalDisableStop || phase==='stopping' || (!isRunning && !killMode))?'not-allowed':'pointer'}}>{killMode ? 'Kill' : 'Stop'}</button>
        {/* Rebuild removed */}
        {(busy || msg) && <span style={{ color: '#9aa4b2', fontSize: 12, alignSelf: 'center' }}>{busy? (busy==='start'?'Starting…':busy==='restart'?'Restarting…':busy==='stop'?'Stopping…':busy==='pull'?'Rebuilding…':'Working…') : msg}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1.3fr', gap: 8, overflow: 'hidden' }}>
        <StatSpark title="CPU" values={cpuSeries} format={(v)=>`${v.toFixed(1)}%`} />
        <StatSpark title="Memory Used" values={memSeries} format={(v)=>formatBytes(v)} />
        <StatSpark title="Networking Down" values={rxSeries} format={(v)=>formatBytes(v)} />
        <StatSpark title="Networking Up" values={txSeries} format={(v)=>formatBytes(v)} />
        <StatSpark title="Disk Read" values={ioReadSeries} format={(v)=>formatBytes(v)} />
        <StatSpark title="Disk Write" values={ioWriteSeries} format={(v)=>formatBytes(v)} />
      </div>
    </div>
  )
}

function AllInline({ token, agg, hist, containers, onBroadcast, onPhaseChange }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const uptime = useMemo(() => {
    if (!agg || typeof agg.uptimeSec !== 'number') return undefined
    const diff = Math.max(0, Math.floor(agg.uptimeSec))
    const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60), s = diff % 60
    const parts = []; if (h) parts.push(`${h}h`); if (m || h) parts.push(`${m}m`); parts.push(`${s}s`)
    return parts.join(' ')
  }, [agg])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const actionAll = async (type) => {
    if (busy) return
    setBusy(type)
    onPhaseChange && onPhaseChange(type, true)
    try {
      const r = await fetch(`/api/containers`, { headers: { Authorization: `Bearer ${token}` } })
      const d = await r.json();
      const items = d.items || []
      await Promise.all(items.map(c => {
        const lowerName = (c.name || '').toLowerCase();
        const lowerImage = (c.image || '').toLowerCase();
        if (lowerName.includes('dockerdash') || lowerImage.includes('dockerdash')) return Promise.resolve();
        return fetch(`/api/containers/${c.id}/${type}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(()=>{})
      }))
      setMsg(type.charAt(0).toUpperCase()+type.slice(1)+' issued for all')
      setTimeout(()=> setMsg(''), 2000)
      onBroadcast && onBroadcast(type)
    } catch { setMsg('Action failed'); setTimeout(()=> setMsg(''), 2500) } finally { setBusy(''); onPhaseChange && onPhaseChange(type, false) }
  }
  const cpuSeries = (hist && hist.cpu && hist.cpu.length) ? hist.cpu : [agg ? (agg.cpuPercent||0) : 0]
  const memSeries = (hist && hist.mem && hist.mem.length) ? hist.mem : [agg ? (agg.memUsage||0) : 0]
  const rxSeries = (hist && hist.rx && hist.rx.length) ? hist.rx : [agg ? (agg.rxBytes||0) : 0]
  const txSeries = (hist && hist.tx && hist.tx.length) ? hist.tx : [agg ? (agg.txBytes||0) : 0]
  const ioReadSeries = (hist && hist.r && hist.r.length) ? hist.r : [agg ? (agg.ioRead||0) : 0]
  const ioWriteSeries = (hist && hist.w && hist.w.length) ? hist.w : [agg ? (agg.ioWrite||0) : 0]
  return (
    <div style={{ background: '#151a21', border: '1px solid #1f2530', borderRadius: 12, padding: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>All Dockers</div>
      <div style={{ color: '#9aa4b2', fontSize: 12, marginBottom: 8 }}>docker:{agg && agg.engineVersion ? agg.engineVersion : 'unknown'}</div>
      <div style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ color: '#22c55e' }}>system running</span>
        {uptime && <span style={{ color: '#9aa4b2' }}>• {uptime}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, width: '100%', flexWrap: 'wrap' }}>
        <button onClick={() => actionAll('start')} disabled={busy!=='' || (containers.every(c => c.state==='running'))} style={{...actionBtnStyle, opacity: (busy!=='' || containers.every(c => c.state==='running'))?0.6:1, cursor: (busy!=='' || containers.every(c => c.state==='running'))?'not-allowed':'pointer'}}>Start</button>
        <button onClick={() => actionAll('restart')} disabled={busy!==''} style={{...actionBtnStyle, opacity: busy!==''?0.6:1, cursor: busy!==''?'not-allowed':'pointer'}}>Restart</button>
        <button onClick={() => actionAll('stop')} disabled={busy!=='' || (containers.every(c => c.state!=='running'))} style={{...dangerBtnStyle, opacity: (busy!=='' || containers.every(c => c.state!=='running'))?0.6:1, cursor: (busy!=='' || containers.every(c => c.state!=='running'))?'not-allowed':'pointer'}}>Stop</button>
        {busy && <span style={{ color: '#9aa4b2', fontSize: 12, alignSelf: 'center' }}>{busy==='start'?'Starting…':busy==='restart'?'Restarting…':'Stopping…'}</span>}
        {!busy && msg && <span style={{ color: '#9aa4b2', fontSize: 12, alignSelf: 'center' }}>{msg}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1.3fr', gap: 8, overflow: 'hidden' }}>
        <StatSpark title="CPU" values={cpuSeries} format={(v)=>`${v.toFixed(1)}%`} />
        <StatSpark title="Memory Used" values={memSeries} format={(v)=>formatBytes(v)} />
        <StatSpark title="Networking Down" values={rxSeries} format={(v)=>formatBytes(v)} />
        <StatSpark title="Networking Up" values={txSeries} format={(v)=>formatBytes(v)} />
        <StatSpark title="Disk Read" values={ioReadSeries} format={(v)=>formatBytes(v)} />
        <StatSpark title="Disk Write" values={ioWriteSeries} format={(v)=>formatBytes(v)} />
      </div>
    </div>
  )
}

function ContainerModal({ container, onClose }) {
  const [tab, setTab] = useState('terminal')
  const [inspectData, setInspectData] = useState(null)
  const [actionBusy, setActionBusy] = useState('')
  const [stats, setStats] = useState(null)

  const doAction = async (id, type) => {
    setActionBusy(type)
    try { await api(`/api/containers/${id}/${type}`, { method: 'POST' }) } catch (e) { alert((e && e.message) || 'Error') } finally { setActionBusy('') }
  }

  const TabButton = ({ id, label }) => (
    <button onClick={() => setTab(id)} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: '1px solid ' + (tab === id ? '#2b3340' : 'transparent'), background: tab === id ? '#202733' : 'transparent', color: '#e5e7eb', cursor: 'pointer' }}>{label}</button>
  )

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(96vw, 1100px)', height: 'min(92vh, 720px)', background: '#0f141a', border: '1px solid #1f2530', borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #1f2530', background: '#0b0f14' }}>
          <div style={{ fontWeight: 600 }}>{container.name}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', color: '#9aa4b2', border: '1px solid #2a2f36', padding: '6px 10px', borderRadius: 8, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <aside style={{ width: 220, borderRight: '1px solid #1f2530', padding: 12, background: '#0b0f14' }}>
            <div style={{ display: 'grid', gap: 8 }}>
              <TabButton id='terminal' label='Terminal' />
              <TabButton id='console' label='Console' />
              <TabButton id='files' label='File Manager' />
              <TabButton id='stats' label='Stats' />
              <TabButton id='network' label='Networking' />
            </div>
          </aside>
          <section style={{ flex: 1, padding: 12, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {tab === 'terminal' && (<TerminalTab containerId={container.id} />)}
              {tab === 'console' && (<LogsTab containerId={container.id} />)}
              {tab === 'files' && (<FilesTab containerId={container.id} />)}
              {tab === 'stats' && (<StatsTab containerId={container.id} stats={stats} setStats={setStats} />)}
              {tab === 'network' && (<NetworkTab containerId={container.id} inspectData={inspectData} setInspectData={setInspectData} />)}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-start' }}>
              <button style={actionBtnStyle} disabled={!!actionBusy} onClick={() => doAction(container.id, 'start')}>{actionBusy==='start'?'Starting…':'Start'}</button>
              <button style={actionBtnStyle} disabled={!!actionBusy} onClick={() => doAction(container.id, 'restart')}>{actionBusy==='restart'?'Restarting…':'Restart'}</button>
              <button style={dangerBtnStyle} disabled={!!actionBusy} onClick={() => doAction(container.id, 'stop')}>{actionBusy==='stop'?'Stopping…':'Stop'}</button>
              <button style={secondaryBtnStyle} disabled={!!actionBusy} onClick={() => doAction(container.id, 'pull')}>{actionBusy==='pull'?'Rebuilding…':'Rebuild'}</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

const actionBtnStyle = { background: '#2563eb', color: 'white', border: 'none', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12, flex: 1, minWidth: 0 }
const secondaryBtnStyle = { background: '#1f2937', color: '#e5e7eb', border: '1px solid #2a2f36', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12, flex: 1, minWidth: 0 }
const dangerBtnStyle = { background: '#b91c1c', color: 'white', border: 'none', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12, flex: 1, minWidth: 0 }

function StatSpark({ title, values, format }) {
  const last = values.length ? values[values.length - 1] : 0
  // Simple inline sparkline using divs
  const max = Math.max(1, ...values)
  const points = values.slice(-40)
  return (
    <div style={{ background: '#0b0f14', border: '1px solid #1f2530', borderRadius: 8, padding: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ color: '#9aa4b2', fontSize: 10 }}>{title}</div>
        <div style={{ fontSize: 10 }}>{format(last || 0)}</div>
      </div>
      <div style={{ position: 'relative', height: 36, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', gap: 2, alignItems: 'flex-end' }}>
          {points.map((v, i) => {
            const h = Math.max(1, Math.round((v / max) * 36))
            return <div key={i} style={{ width: 3, height: h, background: '#2563eb', borderRadius: 2 }} />
          })}
        </div>
      </div>
    </div>
  )
}

function formatBytes(num) {
  const n = Number(num) || 0
  if (n < 1024) return `${n|0} B`
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`
  return `${(n/1024/1024/1024).toFixed(2)} GB`
}
