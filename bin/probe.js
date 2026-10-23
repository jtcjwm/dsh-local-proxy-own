#!/usr/bin/env node
// probe.js - race every node in nodes.txt and rank the survivors by latency.
//
//   node probe.js [--nodes F] [--concurrency 3] [--timeout 9] [--out FILE] [--top N]
//
// Why not just trust a TCP connect test: UDP/QUIC (hysteria2, tuic) and TCP
// (vmess/vless ws+http) fail INDEPENDENTLY. A node can be dead on 443/TCP and
// perfectly alive on 443/UDP. Only a real dial through the real core tells the
// truth, so this spawns one sing-box per candidate.
//
// Concurrency is deliberately LOW (default 3). At 6+ parallel instances the
// tests interfere and even known-good nodes return 000 — a false negative that
// looks exactly like "the whole subscription died". Slow and true beats fast
// and wrong.
//
// Acceptance: HTTP 204 from https://www.gstatic.com/generate_204 AND an egress
// IP that is not the direct baseline. Never rounded up.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readNodes, describe, resolveNodesFile } from './node-parse.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const BINARY = path.join(HERE, 'sing-box.exe')
const RUNTIME = path.join(PKG, '.runtime')
const PROBEDIR = path.join(RUNTIME, 'probe')
const TEST_URL = 'https://www.gstatic.com/generate_204'
const IP_URL = 'http://ip-api.com/line/?fields=countryCode,query'
const PORT_BASE = 19200

function argval(argv, name, dflt) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 700) {
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

async function waitPort(port, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await portOpen(port)) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

function curl(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn('curl.exe', args, { windowsHide: true })
    let out = ''
    let err = ''
    const killer = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, timeoutMs)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => { clearTimeout(killer); resolve({ code: 0, out: '', err: String(e.message) }) })
    p.on('exit', (c) => { clearTimeout(killer); resolve({ code: c, out, err }) })
  })
}

// Direct baseline: without it "the egress changed" is unprovable.
async function baseline() {
  const r = await curl(['-s', '--max-time', '8', IP_URL], 12000)
  const ip = (r.out.split(/\r?\n/)[1] || '').trim()
  const cc = (r.out.split(/\r?\n/)[0] || '').trim()
  return { ip: ip || null, cc: cc || null }
}

async function probeOne(node, idx, opts) {
  let port = PORT_BASE + (idx % 600)
  // If something is ALREADY listening on the probe port, waitPort() would
  // succeed against that stranger and we would measure the wrong process —
  // worst case a direct-egress listener, which reads exactly like a leak.
  for (let tries = 0; tries < 20 && (await portOpen(port, '127.0.0.1', 300)); tries++) {
    port += 1
  }
  if (await portOpen(port, '127.0.0.1', 300)) {
    return { ...describe(node), pass: false, http: '', ms: null, egress: '', egressIp: '',
      error: `no free probe port near ${PORT_BASE + (idx % 600)}` }
  }
  const cfgPath = path.join(PROBEDIR, `${idx}-${port}.json`)
  const cfg = {
    log: { level: 'error', disabled: false },
    inbounds: [{ type: 'socks', listen: '127.0.0.1', listen_port: port, tag: 'in' }],
    outbounds: [{ ...node, tag: 'o' }],
    route: { final: 'o' },
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg))
  const logPath = path.join(PROBEDIR, `${idx}-${port}.log`)
  const logFd = fs.openSync(logPath, 'w')
  const child = spawn(BINARY, ['run', '-c', cfgPath], {
    cwd: PKG, windowsHide: true, stdio: ['ignore', logFd, logFd], detached: true,
  })
  child.unref()

  const rec = { ...describe(node), pass: false, http: '', ms: null, egress: '', egressIp: '', error: '' }
  try {
    const up = await waitPort(port, opts.startupMs)
    if (!up) {
      rec.error = 'core did not open port'
      let tail = ''
      try { tail = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-2).join(' | ') } catch {}
      if (tail) rec.error += ': ' + tail.slice(0, 160)
      return rec
    }
    const t0 = Date.now()
    const r = await curl(['-s', '--max-time', String(opts.timeout), '--socks5-hostname',
      `127.0.0.1:${port}`, '-o', 'NUL', '-w', '%{http_code}', TEST_URL], (opts.timeout + 5) * 1000)
    rec.ms = Date.now() - t0
    rec.http = r.out.trim()
    if (rec.http === '204') {
      const r2 = await curl(['-s', '--max-time', String(opts.timeout), '--socks5-hostname',
        `127.0.0.1:${port}`, IP_URL], (opts.timeout + 5) * 1000)
      const lines = r2.out.split(/\r?\n/)
      rec.egress = r2.out.trim().replace(/\r?\n/g, ' ')
      rec.egressIp = (lines[1] || '').trim()
      rec.port = port
      if (!rec.egressIp) {
        // 204 came back but the egress lookup did not — that is an unverified
        // node, NOT a pass. Say so instead of implying a leak.
        rec.error = 'egress lookup empty (204 ok, egress unverified)'
      } else if (opts.baselineIp && rec.egressIp === opts.baselineIp) {
        rec.error = `LEAK: egress ${rec.egressIp} equals direct baseline`
      } else {
        rec.pass = true
      }
    } else {
      rec.error = 'http ' + (rec.http || '000')
    }
  } catch (e) {
    rec.error = String(e.message || e)
  } finally {
    try { child.kill() } catch {}
    await new Promise((r) => setTimeout(r, 120))
    try { if (child.exitCode === null) spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { windowsHide: true }) } catch {}
    try { fs.closeSync(logFd) } catch {}
    if (!opts.keepLogs) { try { fs.unlinkSync(logPath) } catch {} ; try { fs.unlinkSync(cfgPath) } catch {} }
  }
  return rec
}

async function runPool(items, size, worker) {
  const out = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.max(1, size) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}

export async function probeNodes(opts = {}) {
  const file = opts.nodes || resolveNodesFile(null, PKG)
  const { nodes, skipped } = readNodes(file)
  if (!nodes.length) throw new Error(`no usable nodes in ${file} (skipped ${skipped.length})`)
  fs.mkdirSync(PROBEDIR, { recursive: true })
  const base = await baseline()
  const t0 = Date.now()
  let done = 0
  const results = await runPool(nodes, opts.concurrency || 2, async (n, i) => {
    const r = await probeOne(n, i, { ...opts, baselineIp: base.ip })
    done++
    if (opts.onProgress) opts.onProgress(done, nodes.length, r)
    return r
  })

  // Parallel instances interfere with each other and produce FALSE NEGATIVES —
  // measured: at concurrency 3, two known-good UDP nodes returned 000/direct,
  // and both passed on an immediate serial re-run. So every failure gets one
  // serial retry before it is allowed to be called dead.
  const retry = opts.retry === false ? [] : results
    .map((r, i) => ({ r, i }))
    .filter((x) => !x.r.pass)
  let recovered = 0
  for (const { r, i } of retry) {
    const again = await probeOne(nodes[i], 500 + i, { ...opts, baselineIp: base.ip })
    again.retried = true
    again.firstError = r.error
    if (again.pass) recovered++
    results[i] = again
    if (opts.onProgress) opts.onProgress(done, nodes.length, { ...again, tag: again.tag + ' (retry)' })
  }

  const elapsed = Date.now() - t0
  const alive = results.filter((r) => r.pass).sort((a, b) => (a.ms || 1e9) - (b.ms || 1e9))
  const dead = results.filter((r) => !r.pass)
  const summary = {
    file,
    testedAt: new Date().toISOString(),
    elapsedMs: elapsed,
    baseline: base,
    concurrency: opts.concurrency || 2,
    total: results.length,
    alive: alive.length,
    dead: dead.length,
    retried: retry.length,
    recoveredOnRetry: recovered,
    skipped: skipped.length,
    byKind: {
      udp: { total: results.filter((r) => r.kind === 'udp').length, alive: alive.filter((r) => r.kind === 'udp').length },
      tcp: { total: results.filter((r) => r.kind === 'tcp').length, alive: alive.filter((r) => r.kind === 'tcp').length },
    },
    latencyMs: alive.length ? {
      min: alive[0].ms, median: alive[Math.floor(alive.length / 2)].ms, max: alive[alive.length - 1].ms,
    } : null,
    countries: [...new Set(alive.map((r) => (r.egress || '').split(' ')[0]).filter(Boolean))].sort(),
    ranked: alive,
    deadDetail: dead.map((r) => ({ tag: r.tag, kind: r.kind, server: r.server, error: r.error, retried: !!r.retried })),
    ...(skipped.length ? { skippedDetail: skipped.slice(0, 10) } : {}),
  }
  const outFile = opts.out || path.join(RUNTIME, 'probe.json')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2))
  return summary
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  const opts = {
    nodes: argval(argv, '--nodes', null),
    concurrency: parseInt(argval(argv, '--concurrency', '2'), 10),
    timeout: parseInt(argval(argv, '--timeout', '9'), 10),
    startupMs: parseInt(argval(argv, '--startup-ms', '6000'), 10),
    out: argval(argv, '--out', null),
    keepLogs: argv.includes('--keep-logs'),
    onProgress: (d, n, r) => process.stderr.write(`  [${d}/${n}] ${r.pass ? 'OK  ' : 'DEAD'} ${r.tag} ${r.ms || '-'}ms ${r.egress || r.error}\n`),
  }
  try {
    const s = await probeNodes(opts)
    const top = argv.includes('--top') ? parseInt(argval(argv, '--top', '10'), 10) : s.ranked.length
    console.log(JSON.stringify({
      ok: true, file: s.file, total: s.total, alive: s.alive, dead: s.dead,
      skipped: s.skipped, elapsedMs: s.elapsedMs, baseline: s.baseline,
      byKind: s.byKind, countries: s.countries,
      fastest: s.ranked.slice(0, top).map((r) => ({ tag: r.tag, kind: r.kind, ms: r.ms, egress: r.egress })),
      outFile: opts.out || path.join(RUNTIME, 'probe.json'),
    }, null, 2))
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }))
    process.exit(1)
  }
}
