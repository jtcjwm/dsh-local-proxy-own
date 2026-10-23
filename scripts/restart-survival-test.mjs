// restart-survival-test.mjs - 宿主重启后还能不能收干净、正常路径有没有被弄坏。
//
// 起因（2026-10-21 22:35 实测）：宿主重启 → 它的子进程 proxy.js 随之退出 →
// 退出钩子无条件 clearRuntimeFiles() 把整个 .runtime 删了，连带 sing-box 与守护的
// pid 文件；而这两个是 detached 进程，还活着。结果 status 报 orphan=false、
// stop 找不到东西可杀、start 直接在 18999 上撞端口。
//
// 语义翻转（2026-10-21 23:57，用户原话）：「dsh 打开，vpn 可开可不开，找我要求开就开，
// 不要求开一般就不开，然后我有时候忘了关，但只要关了 dsh 就，全关了」。
// 于是启动时发现幸存者不再「收养续用 + 自动拉起代理」，而是**清扫**：DSH 不在跑，
// VPN 就不该存在。之前那版收养+自动恢复（Fix B/Fix D）已在同一天撤回。
//
// 本脚本验三件事：
//   Fix A  代理子进程退出只清自己的产物（clearRuntimeFiles({scope:'proxy'})），
//          凭据文件保住，所以 start 能复用活核心而不是撞端口
//   清扫   reconcileOnLoad 按端口+映像名+命令行认出自己的幸存进程并杀掉，
//          清掉指向死进程的 pid/state，保留派生缓存，且不自动启动（autoStart 默认 off）
//   正常路径  清扫之后 start/stop 仍然完好，stop 以「端口释放」为判据
//
// 宿主退出那一瞬间的钩子（teardownOnHostExit）由 host-exit-test.mjs 单独验，
// 因为它必须真的 process.exit() 才能触发，测完进程就没了。
//
//   node scripts/restart-survival-test.mjs [--port 17899]
//
// 退出码 0 才算全通过。跑之前请先 local_proxy_stop，否则端口会撞。
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RUNTIME = path.join(ROOT, '.runtime')
const CORE_PORT = 18999

const args = process.argv.slice(2)
const PORT = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 17899

let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const no = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const check = (cond, m) => (cond ? ok(m) : no(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCtx() {
  const tools = new Map()
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {} },
    get(key) {
      if (key === 'tools') {
        return {
          register(definition) {
            tools.set(definition.name, definition)
            return () => tools.delete(definition.name)
          },
        }
      }
      if (key === 'webServer') {
        return {
          register({ path: p, handler }) {
            routes.set(p, handler)
            return () => routes.delete(p)
          },
        }
      }
      return undefined
    },
    inject(keys, callback) {
      if (keys.includes('webServer')) callback(ctx)
      return () => {}
    },
    effect(factory) {
      const dispose = factory()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  return { ctx, tools, routes }
}

// 每次 import 带不同的 query，拿到一个全新的模块实例 = 模拟一次宿主重启
let instanceSeq = 0
async function freshInstance() {
  const mod = await import(`../src/index.js?restart=${++instanceSeq}`)
  if (!Array.isArray(mod.inject) || !mod.inject.includes('tools') || !mod.inject.includes('webServer')) {
    throw new Error('inject 契约被破坏，宿主会静默跳过整个插件')
  }
  const { ctx, tools } = makeCtx()
  mod.apply(ctx)
  // reconcileOnLoad 是 fire-and-forget，内部要跑 netstat + tasklist + powershell
  await sleep(4000)
  return tools
}

async function call(tools, name, payload = {}) {
  const def = tools.get(name)
  if (!def) throw new Error(`工具 ${name} 未注册`)
  const out = await def.execute(payload, {})
  return typeof out === 'string' ? out : JSON.stringify(out)
}

function rtFile(name) {
  const p = path.join(RUNTIME, name)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null
}

function portListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (v) => { sock.destroy(); resolve(v) }
    sock.setTimeout(2500)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/** 轮询等一个运行时文件出现；PowerShell CIM 查询要数秒，不能只等固定时长。 */
async function waitForFile(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = rtFile(name)
    if (text && Number(text) > 0) return true
    if (Date.now() > deadline) return false
    await sleep(500)
  }
}

/** 轮询等端口达到期望状态（up=true 等它开始听，up=false 等它释放）。 */
async function waitForPort(port, up, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await portListening(port)) === up) return true
    if (Date.now() > deadline) return false
    await sleep(400)
  }
}

/** 全机 sing-box.exe 的 pid：独立问 tasklist，不信任何 pid 文件。 */
function singBoxPids() {
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq sing-box.exe', '/FO', 'CSV', '/NH'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.once('error', () => resolve([]))
    child.once('close', () => resolve(
      String(out).split(/\r?\n/).filter((l) => /^"sing-box\.exe"/i.test(l.trim())).map((l) => l.split('","')[1]).filter(Boolean),
    ))
  })
}

/** 全机我们的守护进程 pid。PowerShell -like 不把反斜杠当转义符，模式里别写 \\。 */
function watcherPids() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*singbox-node.js*watch*' } | ForEach-Object { $_.ProcessId }"
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.once('error', () => resolve([]))
    child.once('close', () => resolve(String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)))
  })
}

/** 真在 127.0.0.1:port 上监听的 pid，独立于被测代码直接问 netstat。 */
function pidOnPort(port) {
  return new Promise((resolve) => {
    const child = spawn('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.once('error', () => resolve(null))
    child.once('close', () => {
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
        if (m && Number(m[1]) === Number(port)) return resolve(Number(m[2]))
      }
      resolve(null)
    })
  })
}

/** 独立于被测代码的映像名查询：进程不存在时返回 ''。 */
function imageName(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve('')
    const child = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.once('close', () => {
      const m = out.match(/^"([^"]+)"/)
      resolve(m ? m[1].toLowerCase() : '')
    })
  })
}

function httpCode(url, proxy) {
  return new Promise((resolve) => {
    const argv = ['-s', '--max-time', '25', '-o', 'NUL', '-w', '%{http_code}']
    if (proxy) argv.push('-x', `http://127.0.0.1:${proxy}`)
    argv.push(url)
    const child = spawn('curl.exe', argv, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.once('close', () => resolve(out.trim()))
  })
}

console.log('=== 重启存活测试（Fix A 保凭据 / 启动清扫幸存者 / 正常路径完好）===')
console.log(`  代理端口 ${PORT} · 核心端口 ${CORE_PORT} · .runtime ${RUNTIME}`)

// --- 0. 起点必须干净 ---
console.log('\n-- 0. 起点 --')
check(!(await portListening(PORT)), `${PORT} 空闲`)
check(!(await portListening(CORE_PORT)), `${CORE_PORT} 空闲`)

// --- 1. 起代理 + 核心 + 守护 ---
console.log('\n-- 1. 起全套（竞速 + 守护）--')
let tools = await freshInstance()
const started = await call(tools, 'local_proxy_start', {})
check(/代理已启动|already|ok/.test(started), `local_proxy_start 返回：${started.split('\n')[0].slice(0, 80)}`)
const watched = await call(tools, 'local_proxy_switch', { watch: true })
check(/watch|守护|ok/.test(watched), `守护已开：${watched.split('\n')[0].slice(0, 70)}`)
await sleep(1200)

const proxyPid = Number(rtFile('state.json') ? JSON.parse(rtFile('state.json')).pid : 0)
const corePidBefore = Number(rtFile('singbox.pid') || 0)
const watchPidBefore = Number(rtFile('watch.pid') || 0)
check(proxyPid > 0, `state.json 记下代理 pid ${proxyPid}`)
check(corePidBefore > 0, `singbox.pid 记下核心 pid ${corePidBefore}`)
check(watchPidBefore > 0, `watch.pid 记下守护 pid ${watchPidBefore}`)
check(await portListening(CORE_PORT), `核心在 ${CORE_PORT} 上监听`)
check(await portListening(PORT), `代理在 ${PORT} 上监听`)

// --- 2. 复现宿主退出的那一瞬间：只杀 proxy.js ---
console.log('\n-- 2. 只杀代理子进程（模拟宿主退出带走它的子进程）--')
process.kill(proxyPid)
await sleep(2500)
check(!(await portListening(PORT)), `${PORT} 已随代理退出而释放`)
check(await portListening(CORE_PORT), `核心仍活着（detached，本该如此）`)

// Fix A 的正题：核心的凭据文件必须还在
check(rtFile('singbox.pid') !== null, 'Fix A：singbox.pid 未被清掉')
check(rtFile('singbox-state.json') !== null, 'Fix A：singbox-state.json 未被清掉')
check(rtFile('watch.pid') !== null, 'Fix A：watch.pid 未被清掉')
check(Number(rtFile('singbox.pid')) === corePidBefore, `Fix A：singbox.pid 仍指向原核心 ${corePidBefore}`)
check(rtFile('probe.json') !== null, 'probe.json（探活排名缓存）仍在，下次 start 不用重探')

// --- 3. 再 start：必须复用活核心，不能撞端口 ---
console.log('\n-- 3. 重新 start（应复用活核心，不新建）--')
const restarted = await call(tools, 'local_proxy_start', {})
check(/代理已启动|already/.test(restarted), `start 返回：${restarted.split('\n')[0].slice(0, 80)}`)
await sleep(1500)
check(Number(rtFile('singbox.pid')) === corePidBefore, `核心 pid 未变（仍是 ${corePidBefore}，说明是复用不是重起）`)
check(await portListening(PORT), `${PORT} 重新监听`)
const code = await httpCode('https://www.gstatic.com/generate_204', PORT)
check(code === '204', `经代理 gstatic → ${code}（期望 204）`)

// --- 4. Fix B：连 pid 文件都丢了，也要能认回来 ---
console.log('\n-- 4. 抹掉全部核心凭据文件，再模拟一次宿主重启 --')
// 真实重启里代理子进程必随宿主一起退出（实测 22:35：proxy.js 死了、sing-box 活着），
// 所以模拟必须连旧代理一起杀，否则 17899 上是"旧宿主的孩子"在听，不是重启场景。
const oldProxyPid = Number(JSON.parse(rtFile('state.json')).pid)
process.kill(oldProxyPid)
await sleep(2000)
check(!(await portListening(PORT)), `${PORT} 随旧宿主退出（旧代理 ${oldProxyPid} 已死）`)
for (const f of ['singbox.pid', 'singbox-state.json', 'watch.pid', 'state.json']) {
  try { fs.rmSync(path.join(RUNTIME, f), { force: true }) } catch {}
}
check(rtFile('singbox.pid') === null && rtFile('watch.pid') === null, '凭据文件已抹掉（构造最坏情况）')

const tools2 = await freshInstance() // 全新实例 = 宿主重启，会跑 reconcileOnLoad
// 语义在 2026-10-21 23:57 翻转：用户契约是「只要关了 dsh 就全关了，像没有 vpn 一样」，
// 即 DSH 不在跑，VPN 就不该存在。所以启动时发现的幸存进程是**要清掉的**（说明上次
// 宿主是异常死的，钩子没跑成），不是收养续用；也不会自动把代理拉起来。
await sleep(2000)
const sweptCore = await waitForPort(CORE_PORT, false, 45000)
check(sweptCore, `清扫：幸存核心已被杀掉，${CORE_PORT} 释放（不是收养续用）`)
check(!(await portListening(PORT)), `${PORT} 空闲：autoStart 默认关（「不要求开一般就不开」）`)
const boxes = await singBoxPids()
check(boxes.length === 0, `全机 sing-box.exe 进程数 = ${boxes.length}${boxes.length ? '（' + boxes.join(',') + '）' : ''}`)
const watchers = await watcherPids()
check(watchers.length === 0, `全机 singbox-node watch 守护数 = ${watchers.length}${watchers.length ? '（' + watchers.join(',') + '）' : ''}`)

const reconcileReport = rtFile('reconcile.json')
if (reconcileReport) console.log(`  reconcile.json: ${reconcileReport.replace(/\s+/g, ' ').slice(0, 420)}`)
if (reconcileReport) {
  const rj = JSON.parse(reconcileReport)
  check(rj.action === 'swept', `reconcile 自报 action=${rj.action}（期望 swept）`)
  check(rj.survivors?.core?.swept === true,
    `核心清扫自证：pid=${rj.survivors?.core?.pid} swept=${rj.survivors?.core?.swept} portFree=${rj.survivors?.core?.portFree}`)
  check(rj.survivors?.watcher?.gone === true,
    `守护清扫自证：pid=${rj.survivors?.watcher?.pid} gone=${rj.survivors?.watcher?.gone}`)
  check(rj.autoStart === null, `autoStart 未触发（默认 off）：${JSON.stringify(rj.autoStart)}`)
}
// 指向死进程的 pid/state 文件必须清掉，派生缓存必须留下
for (const f of ['singbox.pid', 'watch.pid', 'singbox-state.json', 'state.json', 'proxy.pid']) {
  check(rtFile(f) === null, `${f} 已清（它指向的进程已死）`)
}
check(rtFile('probe.json') !== null, 'probe.json 保留（探活排名缓存，下次开省 2 分钟重探）')
const statusAfter = await call(tools2, 'local_proxy_status', {})
check(!/运行中/.test(statusAfter), `status 如实报未运行：${statusAfter.split('\n')[0].slice(0, 60)}`)

// --- 5. 清扫之后重新起、再 stop：清理不能把正常路径弄坏 ---
console.log('\n-- 5. 清扫后重新 start → stop（验证清扫没有破坏正常路径）--')
const started2 = await call(tools2, 'local_proxy_start', {})
check(/代理已启动|已在运行/.test(started2), `start 返回：${started2.split('\n')[0].slice(0, 70)}`)
check(await waitForPort(CORE_PORT, true, 45000), `${CORE_PORT} 重新监听`)
check(await waitForPort(PORT, true, 30000), `${PORT} 重新监听`)
const c3 = await httpCode('https://www.gstatic.com/generate_204', PORT)
check(c3 === '204', `经代理 gstatic → ${c3}（期望 204）`)

const stopped = await call(tools2, 'local_proxy_stop', {})
check(/关停|释放/.test(stopped), `stop 返回：${stopped.split('\n')[0].slice(0, 70)}`)
await sleep(2500)
check(!(await portListening(PORT)), `${PORT} 已释放`)
check(!(await portListening(CORE_PORT)), `${CORE_PORT} 已释放`)
// 复活判据：守护若还活着，它会在核心被杀后重新拉起一个
await sleep(2500)
check(!(await portListening(CORE_PORT)), `${CORE_PORT} 再等 2.5s 仍空闲（守护没有把核心复活）`)
const left = fs.existsSync(RUNTIME) ? fs.readdirSync(RUNTIME) : []
const allowed = ['probe.json', 'proxy.pac', 'reconcile.json', 'teardown.json']
check(left.every((f) => allowed.includes(f)), `.runtime 只剩派生产物与证据：[${left.join(', ')}]`)

console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} → ${fail === 0 ? 'PASS' : 'FAIL'} ===`)
process.exit(fail === 0 ? 0 : 1)
