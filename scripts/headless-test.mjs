// Headless harness: drive src/index.js without booting DSH.
//
// It fakes the two cordis services the plugin uses (tools, webServer), serves
// the four routes on a real loopback HTTP server, then walks the full lifecycle
// through the *tool* entry points: status -> start -> double start -> selftest
// -> system-proxy start -> stop -> status -> stop (idempotent).
//
//   node scripts/headless-test.mjs [--port 17899] [--system-proxy]
//
// Exit code 0 only when every assertion passes; this is the same contract as
// scripts/verify.ps1, minus the registry/hosts/route faces.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const portArg = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 17899
const withSystemProxy = args.includes('--system-proxy')

// start 会把 port/upstream 写进 config.json（startProxy 里 saveConfig）。用 --port
// 跑完若不还原，就留下脏配置，后面所有按 17899 假设的测试套件会连锁全红——
// 2026-10-22 07:50 实测踩到：dns-poison / sysproxy / survival 三套 12 条断言全挂，
// 且极易被误判成产品退化。'exit' 钩子在正常结束与未捕获异常时都会触发；本脚本
// 只设 process.exitCode、不调 process.exit()，所以钩子必然执行。
const CONFIG_PATH = path.join(HERE, '..', 'config.json')
const CONFIG_ORIGINAL = fs.readFileSync(CONFIG_PATH, 'utf8')
process.on('exit', () => {
  try {
    if (fs.readFileSync(CONFIG_PATH, 'utf8') !== CONFIG_ORIGINAL) {
      fs.writeFileSync(CONFIG_PATH, CONFIG_ORIGINAL, 'utf8')
      console.log('  (config.json 已还原到测试前)')
    }
  } catch {}
})

const routes = new Map()
const tools = new Map()

const fakeWebServer = {
  register({ kind, path, handler }) {
    if (kind !== 'exact') throw new Error(`unexpected route kind ${kind}`)
    routes.set(path, handler)
    return () => routes.delete(path)
  },
}

const ctx = {
  logger: { warn: (...parts) => console.warn('[warn]', ...parts) },
  get(key) {
    if (key === 'tools') {
      return {
        register(definition) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      }
    }
    if (key === 'webServer') return fakeWebServer
    return undefined
  },
  inject(keys, callback) {
    if (keys.includes('webServer')) callback(ctx)
    return () => {}
  },
  effect(factory) {
    const dispose = factory()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
}

const mod = await import('../src/index.js')
const { apply, name } = mod
apply(ctx)

const EXPECTED_TOOLS = [
  'local_proxy_status',
  'local_proxy_start',
  'local_proxy_stop',
  'local_proxy_selftest',
  'local_proxy_nodes',
  'local_proxy_switch',
  'local_proxy_pac',
  'local_proxy_sysproxy',
]
if (tools.size !== EXPECTED_TOOLS.length) {
  throw new Error(`expected ${EXPECTED_TOOLS.length} tools, got ${tools.size}: ${[...tools.keys()].join(',')}`)
}
for (const t of EXPECTED_TOOLS) {
  if (!tools.has(t)) throw new Error(`tool ${t} missing`)
}

// Regression guard for the 2026-10-21 "loads fine, exposes nothing" bug: cordis
// only starts a plugin after the services listed in its `inject` export exist.
// Without the export, apply() ran before tools/webServer were reachable, so
// registerTools() bailed on its defensive check and registerRoutes() fell into
// the ctx.inject() branch that never fired - zero tools, zero routes, no error.
if (!Array.isArray(mod.inject) || !mod.inject.includes('tools') || !mod.inject.includes('webServer')) {
  throw new Error(`module must export inject including tools+webServer, got ${JSON.stringify(mod.inject)}`)
}
console.log(`PASS module exports inject=${JSON.stringify(mod.inject)}`)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const handler = routes.get(url.pathname)
  if (!handler) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  await handler(req, res)
})

await new Promise((resolve) => server.listen(portArg + 1, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${portArg + 1}`

function assert(condition, label, extra = '') {
  if (condition) {
    console.log(`PASS ${label}`)
    return true
  }
  console.log(`FAIL ${label} ${extra}`)
  process.exitCode = 1
  return false
}

async function call(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await response.json()
  return { status: response.status, json }
}

async function runTool(name, args = {}) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} missing`)
  return tool.execute(args, {})
}

console.log(`plugin=${name} tools=${[...tools.keys()].join(',')} routes=${[...routes.keys()].join(',')}`)

// 1. status before anything
const before = (await call('/dsh-local-proxy-own/status')).json
assert(before.ok === true && before.running === false, 'status: stopped at rest', JSON.stringify(before))

// 2. start without system proxy
const started = (await call('/dsh-local-proxy-own/start', { port: portArg, upstream: '', systemProxy: false })).json
assert(started.ok === true && started.started === true, 'start: proxy up', JSON.stringify(started).slice(0, 300))
assert(Number(started.port) === portArg, 'start: port honoured', `got ${started.port}`)
assert(started.selftest && started.selftest.ok === true, 'start: selftest ok', JSON.stringify(started.selftest))
assert(started.systemProxy === undefined, 'start: system proxy untouched by default')

// 3. idempotent start
const again = (await call('/dsh-local-proxy-own/start', { port: portArg })).json
assert(again.ok === true && again.already === true, 'start: idempotent (already running)')

// 4. tool selftest
const selftest = await runTool('local_proxy_selftest', {})
assert(selftest.ok === true, 'tool: local_proxy_selftest ok', selftest.text)

// 4b. the three node-pool tools added in 0.2.0 - each exercised through its real
// execute() so a wiring regression fails here, not in front of the user.
const nodeList = await runTool('local_proxy_nodes', { action: 'list' })
assert(nodeList.ok === true, 'tool: local_proxy_nodes list ok', String(nodeList.text).slice(0, 200))
assert(/45|条/.test(String(nodeList.text)), 'tool: local_proxy_nodes reports the pool', String(nodeList.text).slice(0, 200))

const pac = await runTool('local_proxy_pac', {})
assert(pac.ok === true, 'tool: local_proxy_pac ok', String(pac.text).slice(0, 200))
assert(/proxy\.pac/.test(String(pac.text)), 'tool: local_proxy_pac returns a file path', String(pac.text).slice(0, 200))

// race:false with no node is the documented no-target path: it must return a
// graceful ok:false instead of throwing or silently starting the core.
const noTarget = await runTool('local_proxy_switch', { race: false })
assert(noTarget.ok === false, 'tool: local_proxy_switch rejects an empty target', String(noTarget.text).slice(0, 200))
assert(/没有要切换的目标/.test(String(noTarget.text)), 'tool: local_proxy_switch explains itself', String(noTarget.text).slice(0, 200))

// 5. http proxy through the plugin's port (end-to-end outside the plugin)
//
// 带重试：连跑整套测试时 127.0.0.1:17899 上会堆几十条 TIME_WAIT（2026-10-22
// 07:20 实测 24+ 条），proxy.js 刚 listen 时首次连接可能连不上。这是环境噪声
// 不是产品缺陷——但红着的测试也不能放任（狼来了会掩盖真退化），所以重试以
// 区分「瞬时干扰」与「真的坏了」。手工重放同一请求三次均得 HTTP 400。
const probe = await (async () => {
  let last = null
  for (let i = 0; i < 4; i++) {
    last = await fetch(`http://127.0.0.1:${portArg}/`, {
      method: 'GET',
      headers: { host: `127.0.0.1:${portArg}` },
    }).catch((error) => ({ ok: false, error }))
    if (last && typeof last.status === 'number') return last
    await new Promise((r) => setTimeout(r, 1500))
  }
  return last
})()
assert(probe && (probe.status === 400 || probe.status === 401), 'proxy port answers HTTP itself (400/401)',
  `status=${probe?.status} err=${probe?.error?.message || '-'} cause=${probe?.error?.cause?.code || probe?.error?.cause?.message || '-'}`)

// 6. optional system proxy round trip
if (withSystemProxy) {
  const withProxy = (await call('/dsh-local-proxy-own/start', { port: portArg, systemProxy: true })).json
  assert(withProxy.ok === true, 'start: systemProxy applied', JSON.stringify(withProxy).slice(0, 300))
  assert(withProxy.systemProxyApplied === true, 'start: ProxyEnable=1', JSON.stringify(withProxy.systemProxy))
  const status = withProxy.status || (await call('/dsh-local-proxy-own/status')).json
  assert(status.systemProxy.enabled === true, 'status: system proxy enabled')
  assert(status.systemProxy.pointsAtUs === true, 'status: ProxyServer points at proxy')

  // toggle off while the proxy keeps running
  const toggledOff = (await call('/dsh-local-proxy-own/start', { port: portArg, systemProxy: false })).json
  assert(toggledOff.ok === true && toggledOff.registryAction === 'restored', 'toggle: system proxy restored while running', JSON.stringify(toggledOff).slice(0, 200))
  const afterOff = toggledOff.status || (await call('/dsh-local-proxy-own/status')).json
  assert(afterOff.running === true, 'toggle: proxy still running')
  assert(afterOff.systemProxy.enabled === false, 'toggle: ProxyEnable back to 0')

  // back on, so the stop path has a snapshot to restore
  const toggledOn = (await call('/dsh-local-proxy-own/start', { port: portArg, systemProxy: true })).json
  assert(toggledOn.ok === true && toggledOn.registryAction === 'applied', 'toggle: system proxy re-applied')
}

// 7. stop
const stopped = (await call('/dsh-local-proxy-own/stop', {})).json
assert(stopped.ok === true, 'stop: ok', JSON.stringify(stopped).slice(0, 400))
// 端口可复用性检查同样受 TIME_WAIT 干扰（残留 socket 让 bind 试不上）。后面
// 的「status: port free after stop」已用 netstat 独立判定端口确实释放，所以
// 这里重试一次；重试后仍不过才判 FAIL。
let reusable = Boolean(stopped.verified && stopped.verified.portReusable === true)
if (!reusable) {
  await new Promise((r) => setTimeout(r, 3000))
  const again = (await call('/dsh-local-proxy-own/stop', {})).json
  reusable = Boolean(again.verified && again.verified.portReusable === true)
}
assert(reusable, 'stop: port reusable',
  `verified=${JSON.stringify(stopped.verified)} ok=${stopped.ok} port=${stopped.port} msg=${stopped.message || ''}`.slice(0, 320))
if (stopped.registry && stopped.registry.verification) {
  assert(stopped.registry.verification.ok === true, 'stop: registry restored', JSON.stringify(stopped.registry.verification))
}

// 8. stop again is still a success
const stoppedTwice = (await call('/dsh-local-proxy-own/stop', {})).json
assert(stoppedTwice.ok === true, 'stop: idempotent')

// 9. status after stop
const after = (await call('/dsh-local-proxy-own/status')).json
assert(after.running === false, 'status: stopped after stop')
assert(after.portFree === true, 'status: port free after stop')

// 9b. a stop must not throw away the derived artifacts. Regression guard for the
// 2026-10-21 bug where clearRuntimeFiles() wiped .runtime wholesale, taking the
// probe ranking cache with it and forcing a full ~70s re-probe on the next start.
const pacPath = path.resolve(HERE, '..', '.runtime', 'proxy.pac')
assert(fs.existsSync(pacPath), 'stop: keeps .runtime/proxy.pac (derived artifact)', pacPath)

// 10. tool stop idempotent
const toolStop = await runTool('local_proxy_stop')
assert(toolStop.ok === true, 'tool: local_proxy_stop ok')

server.close()
console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS')
