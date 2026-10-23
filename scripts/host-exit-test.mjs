// host-exit-test.mjs - 「关了 DSH 就全关了，像没有 vpn 一样」到底成不成立。
//
// 用户契约（2026-10-21 23:56 原话）：
//   「dsh 打开，vpn 可开可不开，找我要求开就开，不要求开一般就不开，
//     然后我有时候忘了关，但只要关了 dsh 就，全关了」
//
// 与 restart-survival-test.mjs 的分工：那个测「宿主重启后能不能收干净」，
// 这个测「宿主退出的那一瞬间，detached 的核心与守护有没有被一起带走」。
// 关键区别是这里**真的触发 process 'exit' 钩子**：up 阶段是一个独立进程，
// 起完全套后直接 process.exit(0)，收尾只能靠同步 API（spawnSync taskkill /
// spawnSync reg），跟 Electron 主进程退出时的处境完全一致。
//
//   node scripts/host-exit-test.mjs                 # 自编排：基线 → up → verify → 兜底
//   node scripts/host-exit-test.mjs up              # 内部：起全套后退出（触发钩子）
//   node scripts/host-exit-test.mjs up --system-proxy   # 内部：同上，且先开系统代理
//   node scripts/host-exit-test.mjs verify --pids a,b,c # 内部：验收
//
// 退出码 0 才算全通过。跑之前请先 local_proxy_stop，否则端口会撞。
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RUNTIME = path.join(ROOT, '.runtime')
const CORE_PORT = 18999
const PROXY_PORT = 17899
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

const argv = process.argv.slice(2)
const phase = argv[0] === 'up' || argv[0] === 'verify' ? argv[0] : 'orchestrate'
const wantSystemProxy = argv.includes('--system-proxy')
const pidsArg = argv.includes('--pids') ? argv[argv.indexOf('--pids') + 1] : ''

let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const no = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const check = (cond, m) => (cond ? ok(m) : no(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- helpers（全部独立于被测代码，不复用插件里的实现） ----------

function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' })
    let done = false
    const fin = (v) => { if (!done) { done = true; try { s.destroy() } catch {} resolve(v) } }
    s.setTimeout(1200)
    s.once('connect', () => fin(true))
    s.once('timeout', () => fin(false))
    s.once('error', () => fin(false))
  })
}

async function waitForPort(port, up, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await portListening(port)) === up) return true
    if (Date.now() > deadline) return false
    await sleep(400)
  }
}

/** 进程是否还存在，用 tasklist 独立问一次，不信 pid 文件。 */
async function pidAlive(pid) {
  if (!pid) return false
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
    return /^"/.test(String(stdout).trim())
  } catch {
    return false
  }
}

async function anySingBoxRunning() {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq sing-box.exe', '/FO', 'CSV', '/NH'], { windowsHide: true })
    const ids = String(stdout).split(/\r?\n/).filter((l) => /^"sing-box\.exe"/i.test(l.trim())).map((l) => l.split('","')[1])
    return ids.filter(Boolean)
  } catch {
    return []
  }
}

async function anyWatcherRunning() {
  // PowerShell -like 不把反斜杠当转义符，模式里不要写 \\（2026-10-21 踩过）
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*singbox-node.js*watch*' } | ForEach-Object { $_.ProcessId }"
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 25000 })
    return String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function regGet(name) {
  const r = spawnSync('reg', ['query', REG_KEY, '/v', name], { windowsHide: true, encoding: 'utf8', timeout: 8000 })
  const out = String(r.stdout || '')
  const m = out.match(new RegExp(`${name}\\s+(REG_\\w+)\\s+(.+)`))
  return m ? { type: m[1], data: m[2].trim() } : null
}

function rtFile(name) {
  try { return fs.readFileSync(path.join(RUNTIME, name), 'utf8') } catch { return null }
}

function makeCtx() {
  const tools = new Map()
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get(key) {
      if (key === 'tools') {
        return { register(d) { tools.set(d.name, d); return () => tools.delete(d.name) } }
      }
      if (key === 'webServer') {
        return { register({ path: p, handler }) { routes.set(p, handler); return () => routes.delete(p) } }
      }
      return undefined
    },
    inject(keys, callback) { if (keys.includes('webServer')) callback(ctx); return () => {} },
    effect(factory) { const d = factory(); return () => { if (typeof d === 'function') d() } },
  }
  return { ctx, tools }
}

// ---------- phase: up ----------
// 起全套，然后 process.exit(0)。钩子必须在同步 API 里把 detached 的核心与守护带走。

async function phaseUp() {
  const mod = await import(`../src/index.js?hostexit=${Date.now()}`)
  const { ctx, tools } = makeCtx()
  mod.apply(ctx)
  await sleep(4500) // 等 fire-and-forget 的 reconcile 跑完（netstat + tasklist + CIM）

  const call = async (name, payload = {}) => {
    const def = tools.get(name)
    if (!def) throw new Error(`工具未注册: ${name}`)
    return await def.execute(payload, {})
  }

  const started = await call('local_proxy_start', wantSystemProxy ? { systemProxy: true } : {})
  // 工具返回 {text,...}，没有可靠的 ok 字段（实测 start 成功时它是 undefined），
  // 所以按文案判；真就绪与否交给下面的端口探测。
  if (!/代理已启动|已在运行/.test(String(started?.text || ''))) {
    console.log(`UP-FAILED start: ${JSON.stringify(started).slice(0, 400)}`)
    process.exit(3)
  }
  await call('local_proxy_switch', { watch: true })
  // watch.pid 现在由 startNodeWatcher 在返回前落盘，但守护自身启动是异步的，
  // 这里轮询等一下，避免几百毫秒的时序差被误判成「没起来」。
  const watchDeadline = Date.now() + 15000
  while (!rtFile('watch.pid') && Date.now() < watchDeadline) await sleep(300)

  if (!(await waitForPort(CORE_PORT, true, 25000))) { console.log('UP-FAILED core-port'); process.exit(3) }
  if (!(await waitForPort(PROXY_PORT, true, 25000))) { console.log('UP-FAILED proxy-port'); process.exit(3) }

  const corePid = (rtFile('singbox.pid') || '').trim()
  const watchPid = (rtFile('watch.pid') || '').trim()
  let proxyPid = (rtFile('proxy.pid') || '').trim()
  if (!proxyPid) {
    try { proxyPid = String(JSON.parse(rtFile('state.json') || '{}')?.pid || '') } catch { proxyPid = '' }
  }
  const sysNow = regGet('ProxyEnable')?.data || '(不存在)'
  // 场景 B 必须真的把系统代理写进去了，否则「退出时还原注册表」这一条根本没被测到
  if (wantSystemProxy && sysNow !== '0x1' && sysNow !== '1') {
    console.log(`UP-FAILED system-proxy-not-applied: ProxyEnable=${sysNow}`)
    process.exit(3)
  }
  if (!corePid || !watchPid) {
    console.log(`UP-FAILED pids-missing: core=${corePid} watch=${watchPid}`)
    process.exit(3)
  }
  console.log(`UP pids=${[proxyPid, corePid, watchPid].join(',')} systemProxy=${wantSystemProxy} ProxyEnable=${sysNow}`)
  // 关键一步：像 DSH 被关掉那样退出。之后的事全凭 'exit' 钩子。
  process.exit(0)
}

// ---------- phase: verify ----------

async function phaseVerify() {
  const pids = pidsArg.split(',').map((s) => Number(s.trim())).filter(Boolean)
  console.log(`  被验对象 pid: ${pids.join(', ') || '(无)'}`)

  // 1. 端口必须全空
  check(!(await portListening(PROXY_PORT)), `${PROXY_PORT} 已释放（代理随宿主退出）`)
  const coreGone = !(await portListening(CORE_PORT))
  check(coreGone, `${CORE_PORT} 已释放（detached 核心被钩子带走）`)
  if (!coreGone) await waitForPort(CORE_PORT, false, 6000) // 给 taskkill 一点余量再判一次
  check(!(await portListening(CORE_PORT)), `${CORE_PORT} 再等 6s 仍未复活（守护也死了，没人重起它）`)

  // 2. 那三个 pid 必须都已不存在
  for (const pid of pids) {
    check(!(await pidAlive(pid)), `pid ${pid} 已不存在`)
  }

  // 3. 映像级复查：全机不能有我们的 sing-box，也不能有守护
  const boxes = await anySingBoxRunning()
  check(boxes.length === 0, `全机 sing-box.exe 进程数 = ${boxes.length}${boxes.length ? '（' + boxes.join(',') + '）' : ''}`)
  const watchers = await anyWatcherRunning()
  check(watchers.length === 0, `全机 singbox-node watch 守护数 = ${watchers.length}${watchers.length ? '（' + watchers.join(',') + '）' : ''}`)

  // 4. 系统代理必须回到原样：这是唯一「别人能看出来」的痕迹
  const enable = regGet('ProxyEnable')
  const server = regGet('ProxyServer')
  const pac = regGet('AutoConfigURL')
  const enableOff = !enable || enable.data === '0x0' || enable.data === '0'
  check(enableOff, `ProxyEnable = ${enable ? enable.data : '(不存在)'}（必须为 0 或不存在）`)
  check(!server, `ProxyServer = ${server ? server.data : '(不存在)'}（开了系统代理的场景必须被删掉）`)
  check(!pac, `AutoConfigURL = ${pac ? pac.data : '(不存在)'}`)

  // 5. 钩子必须留下证据，否则「杀干净了」和「根本没起过」无法区分
  const td = rtFile('teardown.json')
  check(Boolean(td), 'teardown.json 存在（钩子确实跑过）')
  if (td) {
    const j = JSON.parse(td)
    check(Array.isArray(j.killed) && j.killed.length > 0, `teardown 记录了 ${j.killed?.length} 次 taskkill：${JSON.stringify(j.killed)}`)
    check(j.killed.every((k) => k.status === 0), `taskkill 全部退出码 0（${j.killed.map((k) => k.status).join(',')}）`)
  }

  // 6. .runtime 只留派生产物与证据，pid/state 必须清掉
  const left = fs.existsSync(RUNTIME) ? fs.readdirSync(RUNTIME).sort() : []
  const stale = left.filter((f) => ['state.json', 'proxy.pid', 'singbox.pid', 'watch.pid', 'singbox-state.json', 'registry-snapshot.json'].includes(f))
  check(stale.length === 0, `pid/state/快照文件已清（残留：${stale.join(',') || '无'}）`)
  check(left.includes('probe.json'), `probe.json 保留（下次开不用重探 2 分钟）：${left.join(', ')}`)

  // 7. 负向测试：直连出口必须还是国内，证明没留下任何接管
  try {
    const { stdout } = await execFileAsync('curl.exe', ['-s', '--noproxy', '*', '--max-time', '15', 'https://myip.ipip.net'], { windowsHide: true })
    const cn = /中国/.test(stdout)
    check(cn, `直连出口 = ${stdout.trim().slice(0, 60)}（必须仍在国内）`)
  } catch (error) {
    no(`直连出口查询失败：${error.message}`)
  }
}

// ---------- phase: orchestrate ----------

async function orchestrate(runSystemProxyScenario) {
  console.log(`\n-- 场景${runSystemProxyScenario ? ' B：忘了关 + 系统代理开着' : ' A：忘了关（没开系统代理）'} --`)

  // 起点必须干净，否则测的是别人的残留
  const preCore = await portListening(CORE_PORT)
  const preProxy = await portListening(PROXY_PORT)
  if (preCore || preProxy) {
    console.log(`  ✗ 起点不干净（${PROXY_PORT}=${preProxy} ${CORE_PORT}=${preCore}），请先 local_proxy_stop`)
    fail++
    return
  }
  const baseEnable = regGet('ProxyEnable')?.data || '(不存在)'
  const baseServer = regGet('ProxyServer')?.data || '(不存在)'
  console.log(`  基线：ProxyEnable=${baseEnable} ProxyServer=${baseServer}`)

  const upArgs = ['up', ...(runSystemProxyScenario ? ['--system-proxy'] : [])]
  const up = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...upArgs], {
    cwd: HERE, encoding: 'utf8', timeout: 180000, windowsHide: true,
  })
  const upOut = String(up.stdout || '') + String(up.stderr || '')
  const m = upOut.match(/UP pids=([\d,]+)/)
  if (!m) {
    no(`up 阶段没起来：exit=${up.status}\n${upOut.split(/\r?\n/).slice(-12).map((l) => '    ' + l).join('\n')}`)
    return
  }
  console.log(`  ${upOut.split(/\r?\n/).filter((l) => l.startsWith('UP ')).join('\n  ')}`)
  ok(`up 阶段全套已起（pid ${m[1]}），宿主进程 exit=${up.status}`)

  await sleep(2500) // 给同步 taskkill 与注册表写回留落地时间

  const verify = await new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'verify', '--pids', m[1]], { cwd: HERE, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d) })
    child.once('close', (code) => resolve({ code, out }))
  })

  // 兜底：万一钩子失效把系统代理留在死端口上，绝不能让用户的网断着过夜
  const nowEnable = regGet('ProxyEnable')?.data
  if (nowEnable === '0x1' || nowEnable === '1') {
    console.log('  ⚠ 兜底：系统代理仍指向死端口，手工还原')
    spawnSync('reg', ['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'], { windowsHide: true })
    spawnSync('reg', ['delete', REG_KEY, '/v', 'ProxyServer', '/f'], { windowsHide: true })
    fail++
  }
  return verify.code
}

// ---------- entry ----------

if (phase === 'up') {
  await phaseUp()
} else if (phase === 'verify') {
  await phaseVerify()
  console.log(`\n  本阶段：PASS ${pass} / FAIL ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
} else {
  console.log('=== 宿主退出联动测试（关了 DSH 就全关了，像没有 vpn 一样）===')
  const codeA = await orchestrate(false)
  await sleep(1500)
  const codeB = await orchestrate(true)
  // verify 跑在子进程里，它的 PASS/FAIL 只体现在退出码上，由编排层汇总判定。
  const bad = (codeA === 0 ? 0 : 1) + (codeB === 0 ? 0 : 1) + fail
  console.log(`\n=== 结果：${bad === 0 ? 'PASS' : 'FAIL'}（场景A verify 退出=${codeA}，场景B verify 退出=${codeB}，编排层 FAIL ${fail}）===`)
  process.exit(bad === 0 ? 0 : 1)
}
