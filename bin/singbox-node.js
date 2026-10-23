#!/usr/bin/env node
// singbox-node.js - run nodes from nodes.txt as a local SOCKS5 egress.
//
// Zero dependencies. Turns a share-link URI (vless/vmess/hysteria2/tuic) into a
// minimal sing-box config, starts the bundled sing-box.exe on 127.0.0.1:<port>,
// waits until the port actually accepts, and records a pid file so stop is exact.
//
//   node singbox-node.js list   [--nodes F]
//   node singbox-node.js probe  [--nodes F] [--concurrency 3] [--top 10]
//   node singbox-node.js start  <tag|auto|race> [--port 18999] [--nodes F] [--top N]
//   node singbox-node.js reload [--nodes F]        # hot-swap without moving the port
//   node singbox-node.js stop
//   node singbox-node.js status
//
// Three start modes:
//   <tag>  one named node, exactly as written
//   auto   fastest node from the probe cache (falls back to the first line)
//   race   every live node in one sing-box `urltest` group — the CORE does the
//          racing and fails over in well under a second, with no restart at all
//
// Everything runtime-ish lives in .runtime/ and is deleted on stop.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readNodes, describe, resolveNodesFile } from './node-parse.js'
import { buildRoute, MODES } from './route-rules.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const BINARY = path.join(HERE, 'sing-box.exe')
const RUNTIME = path.join(PKG, '.runtime')
const CONFIG = path.join(RUNTIME, 'sing-box.json')
const PIDFILE = path.join(RUNTIME, 'singbox.pid')
const STATEF = path.join(RUNTIME, 'singbox-state.json')
const LOGF = path.join(RUNTIME, 'sing-box.log')
const PROBEF = path.join(RUNTIME, 'probe.json')
const WATCHPID = path.join(RUNTIME, 'watch.pid')
const DEFAULT_PORT = 18999
const PROBE_TTL_MS = 30 * 60 * 1000

function die(msg, code = 1) {
  process.stderr.write(String(msg) + '\n')
  process.exit(code)
}

function ensureRuntime() {
  fs.mkdirSync(RUNTIME, { recursive: true })
}

function loadNodes(file) {
  const { nodes, skipped } = readNodes(file)
  if (!nodes.length) {
    die(`no usable nodes in ${file} (skipped ${skipped.length}: ` +
      JSON.stringify(skipped.slice(0, 3)) + ')')
  }
  return { nodes, skipped }
}

function readProbeCache(maxAgeMs = PROBE_TTL_MS) {
  try {
    const c = JSON.parse(fs.readFileSync(PROBEF, 'utf8'))
    const age = Date.now() - Date.parse(c.testedAt || 0)
    if (!Number.isFinite(age) || age > maxAgeMs) return null
    return { ...c, ageMs: age }
  } catch {
    return null
  }
}

function pick(nodes, want, probe) {
  if (!want || want === 'auto') {
    if (probe && probe.ranked && probe.ranked.length) {
      const best = probe.ranked[0].tag
      const hit = nodes.find((n) => n.tag === best)
      if (hit) return hit
    }
    return nodes[0]
  }
  const hit = nodes.find((n) => n.tag === want)
  if (!hit) {
    die(`node not found: ${want}\navailable:\n` + nodes.map((n) => '  ' + n.tag).join('\n'))
  }
  return hit
}

// `mixed` serves HTTP CONNECT and SOCKS5 on one port, so the same listener
// works for curl -x http://, curl --socks5-hostname and proxy.js alike.
// Pass --inbound socks to get the old socks-only behaviour back.
function makeInbound(port, kind) {
  return {
    type: kind === 'socks' ? 'socks' : 'mixed',
    listen: '127.0.0.1',
    listen_port: port,
    tag: 'socks-in',
  }
}

function buildConfig(node, port, opts = {}) {
  // Single-node mode is the diagnostic mode: send everything through the node
  // so "does this node work" has one unambiguous answer.
  const route = buildRoute(opts.split || 'all', { group: node.tag })
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [makeInbound(port, opts.inbound)],
    outbounds: [node, { type: 'direct', tag: 'direct' }],
    route,
  }
}

// race mode: one urltest group over every live node. The core re-tests on its
// own interval and moves traffic without a restart, which is what makes the
// failover sub-second instead of "restart and hope".
function buildRaceConfig(nodes, port, opts = {}) {
  const tags = nodes.map((n) => n.tag)
  const group = {
    type: 'urltest',
    tag: 'auto',
    outbounds: tags,
    interval: opts.interval || '30s',
    tolerance: opts.tolerance || 50,
    ...(opts.url ? { url: opts.url } : {}),
  }
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [makeInbound(port, opts.inbound)],
    outbounds: [...nodes, group, { type: 'direct', tag: 'direct' }],
    // race mode is the daily driver: domestic + LAN traffic stays direct so it
    // does not pay the tunnel round-trip, everything else goes through `auto`.
    route: buildRoute(opts.split || 'cn-direct', { group: 'auto' }),
  }
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host })
    let done = false
    const fin = (ok) => {
      if (done) return
      done = true
      try { s.destroy() } catch {}
      resolve(ok)
    }
    s.setTimeout(timeoutMs)
    s.once('connect', () => fin(true))
    s.once('timeout', () => fin(false))
    s.once('error', () => fin(false))
  })
}

async function waitPort(port, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await portOpen(port)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function waitPortGone(port, ms = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!(await portOpen(port, '127.0.0.1', 300))) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATEF, 'utf8'))
  } catch {
    return null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function spawnCore(cfg) {
  const logFd = fs.openSync(LOGF, 'a')
  const child = spawn(BINARY, ['run', '-c', CONFIG], {
    cwd: PKG,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  })
  child.unref()
  try { fs.closeSync(logFd) } catch {}
  return child
}

function logTail(n = 12) {
  try {
    return fs.readFileSync(LOGF, 'utf8').split(/\r?\n/).slice(-n).join('\n')
  } catch {
    return ''
  }
}

async function killPid(pid, port) {
  try { process.kill(pid) } catch {}
  const t0 = Date.now()
  while (Date.now() - t0 < 4000 && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 200))
  }
  if (isAlive(pid)) {
    try {
      await new Promise((resolve) => {
        const p = spawn('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true })
        p.on('exit', resolve)
        p.on('error', resolve)
      })
    } catch {}
  }
  if (port) await waitPortGone(port)
}

// Which nodes go into race mode: the probe cache when it is fresh, otherwise
// everything in the file (the core will sort out the dead ones itself).
function raceSet(nodes, probe, top) {
  if (probe && probe.ranked && probe.ranked.length) {
    const order = probe.ranked.map((r) => r.tag)
    const sorted = [...nodes].sort((a, b) => {
      const ia = order.indexOf(a.tag); const ib = order.indexOf(b.tag)
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib)
    })
    return top ? sorted.slice(0, top) : sorted
  }
  return top ? nodes.slice(0, top) : nodes
}

async function cmdStart(want, port, opts) {
  if (!fs.existsSync(BINARY)) die(`sing-box.exe missing: ${BINARY}`)
  const st = readState()
  if (st && st.pid && isAlive(st.pid) && (await portOpen(st.port))) {
    console.log(JSON.stringify({ ok: true, already: true, ...st }))
    return
  }
  const nodesFile = opts.nodes
  const { nodes, skipped } = loadNodes(nodesFile)
  const probe = readProbeCache(opts.probeTtlMs)
  ensureRuntime()

  let cfg, state
  if (want === 'race') {
    const set = raceSet(nodes, probe, opts.top)
    cfg = buildRaceConfig(set, port, opts)
    state = {
      mode: 'race', pid: 0, port, node: `auto(${set.length})`,
      nodes: set.length, tags: set.map((n) => n.tag),
      server: set.slice(0, 3).map((n) => `${n.server}:${n.server_port}`).join(','),
      probeAgeMs: probe ? probe.ageMs : null, startedAt: Date.now(),
    }
  } else {
    const node = pick(nodes, want, probe)
    cfg = buildConfig(node, port, opts)
    state = {
      mode: 'single', pid: 0, port, node: node.tag, nodes: 1,
      server: `${node.server}:${node.server_port}`, kind: describe(node).kind,
      fromProbe: !!(probe && want === 'auto'), startedAt: Date.now(),
    }
  }
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')
  const child = spawnCore(cfg)
  state.pid = child.pid

  const up = await waitPort(port)
  if (!up) {
    await killPid(child.pid)
    die(`sing-box did not open 127.0.0.1:${port}\n--- log tail ---\n${logTail()}`)
  }
  fs.writeFileSync(PIDFILE, String(child.pid), 'utf8')
  fs.writeFileSync(STATEF, JSON.stringify(state, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: true, skipped: skipped.length, ...state }))
}

// Hot swap: same port, new node set. proxy.js resolves the upstream per
// connection, so clients on the stable port only see the ~1s gap while the
// core restarts — no proxy restart, no system-proxy flip.
async function cmdReload(opts) {
  const st = readState()
  if (!st || !st.pid || !isAlive(st.pid)) {
    console.log(JSON.stringify({ ok: false, error: 'not running; use start' }))
    process.exit(1)
  }
  const { nodes, skipped } = loadNodes(opts.nodes)
  const probe = readProbeCache(opts.probeTtlMs)
  const t0 = Date.now()
  let cfg, next, selected
  if (st.mode === 'race') {
    const set = raceSet(nodes, probe, opts.top)
    cfg = buildRaceConfig(set, st.port, opts)
    selected = set.map((n) => n.tag)
    next = { ...st, nodes: set.length, tags: selected, node: `auto(${set.length})` }
  } else {
    const node = pick(nodes, st.node, probe)
    cfg = buildConfig(node, st.port, opts)
    selected = [node.tag]
    next = { ...st, node: node.tag, server: `${node.server}:${node.server_port}` }
  }
  // Diff the SELECTED set, not the whole file — otherwise every reload claims
  // it "added" all the nodes it never put in the config.
  const had = new Set(st.tags || [st.node])
  const now = new Set(selected)
  const added = [...now].filter((t) => !had.has(t))
  const removed = [...had].filter((t) => !now.has(t))

  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')
  await killPid(st.pid, st.port)
  const child = spawnCore(cfg)
  const up = await waitPort(st.port)
  const gapMs = Date.now() - t0
  if (!up) {
    await killPid(child.pid)
    console.log(JSON.stringify({ ok: false, error: 'core did not come back', gapMs, log: logTail() }))
    process.exit(1)
  }
  next.pid = child.pid
  next.reloadedAt = Date.now()
  next.probeAgeMs = probe ? probe.ageMs : null
  fs.writeFileSync(PIDFILE, String(child.pid), 'utf8')
  fs.writeFileSync(STATEF, JSON.stringify(next, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: true, gapMs, pid: child.pid, port: st.port, mode: st.mode,
    nodes: next.nodes, added: added.length, removed: removed.length, skipped: skipped.length }))
}

// The watcher is detached and its only handle is WATCHPID. When that file is
// lost (host restart, an external cleanup, a crash) `stop` used to kill the core
// and walk away — and the watcher, seeing the core go down on its next tick,
// restarted it. Measured 2026-10-21 23:03: `stop` reported "节点进程已停止"
// while 18999 was listening again seconds later, and 18999/17899 both stayed
// occupied after the plugin's own stop path returned. So fall back to
// identifying the watcher by its command line, which only this plugin produces.
async function findWatcherPids() {
  const found = []
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // -like does not treat backslash as an escape: a single one, or none.
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*singbox-node.js*watch*' } | ForEach-Object { $_.ProcessId }",
        ],
        { windowsHide: true },
      )
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.once('error', reject)
      child.once('close', () => resolve(out))
    })
    for (const line of String(stdout).split(/\r?\n/)) {
      const pid = Number(line.trim())
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) found.push(pid)
    }
  } catch {}
  return found
}

async function killWatcher(wpid) {
  try { process.kill(wpid) } catch {}
  const t = Date.now()
  while (Date.now() - t < 3000 && isAlive(wpid)) await new Promise((r) => setTimeout(r, 150))
  if (isAlive(wpid)) {
    try { spawn('taskkill', ['/F', '/PID', String(wpid)], { windowsHide: true }) } catch {}
    const t2 = Date.now()
    while (Date.now() - t2 < 2000 && isAlive(wpid)) await new Promise((r) => setTimeout(r, 150))
  }
  return !isAlive(wpid)
}

// PID actually listening on 127.0.0.1:port, or null. The state file can lag
// reality: the watcher may have restarted a fresh core moments before it died,
// and that new pid never made it into singbox-state.json.
async function pidOnPort(port) {
  try {
    const out = await new Promise((resolve) => {
      const p = spawn('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true })
      let s = ''
      p.stdout.on('data', (d) => { s += d })
      p.once('error', () => resolve(''))
      p.once('close', () => resolve(s))
    })
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
      if (m && Number(m[1]) === Number(port)) return Number(m[2])
    }
  } catch {}
  return null
}

async function cmdStop(defaultPort) {
  // Kill the watcher FIRST, otherwise it sees the core go down and restarts it
  // before stop can finish — a stop that resurrects its own target.
  let watcher = null
  try {
    const wpid = parseInt(fs.readFileSync(WATCHPID, 'utf8'), 10)
    if (wpid && isAlive(wpid)) {
      watcher = wpid
      await killWatcher(wpid)
    }
  } catch {}
  try { fs.unlinkSync(WATCHPID) } catch {}

  // WATCHPID missing or stale: sweep by command line so no watcher survives.
  const swept = []
  for (const wpid of await findWatcherPids()) {
    if (wpid === watcher) continue
    if (await killWatcher(wpid)) swept.push(wpid)
  }

  const st = readState()
  const port = (st && st.port) || defaultPort || DEFAULT_PORT
  let stopped = null
  if (st && st.pid) {
    await killPid(st.pid, port)
    stopped = st.pid
  }
  // "Killed the recorded pid" is not the same as "the port is free". Measured
  // 2026-10-21 23:36: stop reported the core stopped while 18999 kept serving -
  // the watcher had restarted a fresh core just before dying and the new pid
  // never reached the state file. Stop's success criterion is a free port, so
  // sweep by port until nothing of ours is left listening.
  const sweptCore = []
  for (let i = 0; i < 3; i++) {
    const left = await pidOnPort(port)
    if (!left) break
    await killPid(left, port)
    sweptCore.push(left)
  }
  const portGone = (await pidOnPort(port)) === null
  cleanup()
  console.log(JSON.stringify({
    ok: true, already: stopped === null, stopped, port, portGone, sweptCore,
    watcher: watcher || null, swept,
  }))
}

function cleanup() {
  for (const f of [PIDFILE, STATEF, CONFIG, LOGF, WATCHPID]) {
    try { fs.unlinkSync(f) } catch {}
  }
  // Per-node probe configs/logs. probe.json (the ranking cache) and proxy.pac
  // stay on purpose: they are derived artifacts, not live state, and throwing
  // the cache away would force a full 70 s re-probe on the next start.
  try { fs.rmSync(path.join(RUNTIME, 'probe'), { recursive: true, force: true }) } catch {}
  try {
    if (fs.existsSync(RUNTIME) && fs.readdirSync(RUNTIME).length === 0) fs.rmdirSync(RUNTIME)
  } catch {}
}

async function cmdStatus() {
  const st = readState()
  if (!st) {
    console.log(JSON.stringify({ running: false }))
    return
  }
  const alive = isAlive(st.pid)
  const open = alive ? await portOpen(st.port) : false
  const probe = readProbeCache(Infinity)
  console.log(JSON.stringify({
    running: alive && open, pid: st.pid, port: st.port, mode: st.mode || 'single',
    node: st.node, nodes: st.nodes || 1, server: st.server,
    uptimeMs: alive ? Date.now() - (st.startedAt || 0) : 0,
    probe: probe ? { testedAt: probe.testedAt, ageMs: probe.ageMs, alive: probe.alive, total: probe.total } : null,
  }))
}

function cmdList(opts) {
  const { nodes, skipped } = loadNodes(opts.nodes)
  const probe = readProbeCache(Infinity)
  const rank = new Map((probe && probe.ranked ? probe.ranked : []).map((r, i) => [r.tag, { rank: i + 1, ms: r.ms, egress: r.egress }]))
  console.log(JSON.stringify({
    file: opts.nodes,
    total: nodes.length,
    skipped: skipped.length,
    probeAgeMs: probe ? probe.ageMs : null,
    nodes: nodes.map((n) => ({ ...describe(n), ...(rank.get(n.tag) || {}) })),
    ...(skipped.length ? { skippedDetail: skipped.slice(0, 10) } : {}),
  }, null, 2))
}

async function cmdProbe(opts) {
  const { probeNodes } = await import('./probe.js')
  const s = await probeNodes({
    nodes: opts.nodes,
    concurrency: opts.concurrency,
    timeout: opts.timeout,
    startupMs: opts.startupMs,
    out: opts.out,
    onProgress: opts.quiet ? null : (d, n, r) =>
      process.stderr.write(`  [${d}/${n}] ${r.pass ? 'OK  ' : 'DEAD'} ${r.tag} ${r.ms || '-'}ms ${r.egress || r.error}\n`),
  })
  console.log(JSON.stringify({
    ok: true, total: s.total, alive: s.alive, dead: s.dead, skipped: s.skipped,
    elapsedMs: s.elapsedMs, baseline: s.baseline, byKind: s.byKind, countries: s.countries,
    fastest: s.ranked.slice(0, opts.top).map((r) => ({ tag: r.tag, kind: r.kind, ms: r.ms, egress: r.egress })),
    deadTags: s.deadDetail.map((d) => d.tag),
    cache: PROBEF,
  }, null, 2))
}

// watch: keep a race instance up, reload when nodes.txt changes, and refresh
// the probe cache on an interval so the fastest-node ordering stays honest.
// The listening port never moves, so consumers see a ~0.2 s blip at most.
async function cmdWatch(opts, port) {
  const file = opts.nodes
  if (!fs.existsSync(file)) die(`nodes file not found: ${file}`)
  const st = readState()
  if (!(st && st.pid && isAlive(st.pid) && (await portOpen(st.port)))) {
    await cmdStart('race', port, { ...opts, top: opts.top })
  }
  let mtime = fs.statSync(file).mtimeMs
  let lastProbe = readProbeCache(Infinity)
  let lastProbeAt = lastProbe ? Date.parse(lastProbe.testedAt) : 0
  const state0 = readState()
  fs.writeFileSync(STATEF, JSON.stringify({ ...state0, watching: { file, since: Date.now() } }, null, 2))
  fs.writeFileSync(WATCHPID, String(process.pid), 'utf8')
  const say = (o) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n')
  say({ event: 'watch-start', pid: process.pid, file, port, reprobeEveryMin: opts.reprobeMin })

  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      let m = 0
      try { m = fs.statSync(file).mtimeMs } catch {}
      const cur = readState()
      if (!cur || !cur.pid || !isAlive(cur.pid)) {
        say({ event: 'core-down', restarting: true })
        await cmdStart(cur && cur.mode === 'single' ? cur.node : 'race', port, opts)
      } else if (m !== mtime) {
        mtime = m
        say({ event: 'nodes-changed', reloading: true })
        await cmdReload(opts)
      } else if (opts.reprobeMin && Date.now() - lastProbeAt > opts.reprobeMin * 60 * 1000) {
        say({ event: 'reprobe-start' })
        const { probeNodes } = await import('./probe.js')
        const s = await probeNodes({ nodes: file, concurrency: opts.concurrency, timeout: opts.timeout, out: PROBEF })
        lastProbeAt = Date.now()
        say({ event: 'reprobe-done', alive: s.alive, dead: s.dead, elapsedMs: s.elapsedMs, reloading: true })
        await cmdReload(opts)
      }
    } catch (e) {
      say({ event: 'error', error: String(e.message || e) })
    } finally {
      busy = false
    }
  }
  const iv = setInterval(tick, opts.watchMs)
  const stop = async () => {
    clearInterval(iv)
    try { fs.unlinkSync(WATCHPID) } catch {}
    say({ event: 'watch-stop' })
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  await tick()
  // stay alive
  await new Promise(() => {})
}

const argv = process.argv.slice(2)
const cmd = argv[0]
const rest = argv.slice(1)
function flag(name, dflt) {
  const i = rest.indexOf(name)
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : dflt
}
function intFlag(name, dflt) {
  const v = flag(name, null)
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : dflt
}
const VALUE_FLAGS = new Set(['--port', '--nodes', '--top', '--concurrency', '--timeout',
  '--interval', '--tolerance', '--startup-ms', '--probe-ttl', '--out', '--inbound', '--split'])
const positional = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a)) i++ // skip the flag's value too
    continue
  }
  positional.push(a)
}

const opts = {
  nodes: resolveNodesFile(flag('--nodes', null), PKG),
  top: intFlag('--top', 0) || undefined,
  concurrency: intFlag('--concurrency', 2),
  timeout: intFlag('--timeout', 9),
  startupMs: intFlag('--startup-ms', 6000),
  interval: flag('--interval', '30s'),
  inbound: flag('--inbound', 'mixed'),
  split: flag('--split', null),
  tolerance: intFlag('--tolerance', 50),
  probeTtlMs: intFlag('--probe-ttl', 30) * 60 * 1000,
  out: flag('--out', null),
  watchMs: intFlag('--watch-ms', 3000),
  reprobeMin: intFlag('--reprobe-min', 0),
  quiet: rest.includes('--quiet'),
}
const portArg = intFlag('--port', DEFAULT_PORT)

switch (cmd) {
  case 'list':
    cmdList(opts)
    break
  case 'probe':
    await cmdProbe(opts)
    break
  case 'start':
    await cmdStart(positional[0] || 'auto', portArg, opts)
    break
  case 'reload':
    await cmdReload(opts)
    break
  case 'watch':
    await cmdWatch(opts, portArg)
    break
  case 'stop':
    await cmdStop(portArg)
    break
  case 'status':
    await cmdStatus()
    break
  default:
    console.log('usage: singbox-node.js <list|probe|start|reload|watch|stop|status> [tag|auto|race] [--port N] [--nodes F] [--top N] [--split cn-direct|all|direct] [--concurrency N] [--interval 30s] [--reprobe-min N]')
    process.exit(2)
}
