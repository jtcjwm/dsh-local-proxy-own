// sysproxy-test.mjs - 系统代理三档 + 守卫 + 中文分流别名，端到端实测。
//
// 验的是第 2 组交付物（2026-10-22 00:45）：
//   档位   off / pac / global 三档一键切换，快照只在 off -> on 采集一次
//   守卫   每 N 秒核对注册表，被别的程序改回去就写回（Clash Verge Rev 叫
//          「系统代理和守卫」，守卫才是有价值的那一半）
//   别名   分流档接受「直连/规则/全局」中文说法
//
// 守卫的证伪方式是**真的用 reg.exe 把它改坏**，然后看它有没有自己修回来。
// 只听守卫自报「巡检 N 次」不算证据。
//
//   node scripts/sysproxy-test.mjs [--port 17899]
//
// 退出码 0 才算全通过。会写 HKCU 注册表（无需管理员），跑前请 local_proxy_stop。
// 无论成败，finally 里都会把注册表还原到基线，绝不留系统代理指向死端口。
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
const CONFIG = path.join(ROOT, 'config.json')
const SNAPSHOT = path.join(RUNTIME, 'registry-snapshot.json')
const CORE_PORT = 18999
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

const argv = process.argv.slice(2)
const PORT = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 17899
const GUARD_SEC = 10 // 最小允许值，为了测试别等太久

let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const no = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const check = (cond, m) => (cond ? ok(m) : no(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

function reg(name) {
  const r = spawnSync('reg', ['query', REG_KEY, '/v', name], { windowsHide: true, encoding: 'utf8', timeout: 8000 })
  const m = String(r.stdout || '').match(new RegExp(`${name}\\s+(REG_\\w+)\\s+(.+)`))
  return m ? m[2].trim() : null
}

function regSet(name, type, data) {
  return spawnSync('reg', ['add', REG_KEY, '/v', name, '/t', type, '/d', data, '/f'], { windowsHide: true, encoding: 'utf8', timeout: 8000 }).status === 0
}

function regDel(name) {
  spawnSync('reg', ['delete', REG_KEY, '/v', name, '/f'], { windowsHide: true, encoding: 'utf8', timeout: 8000 })
}

/** 把注册表打回测试前的基线：ProxyEnable=0x0，其余三项不存在。 */
function restoreBaseline() {
  regSet('ProxyEnable', 'REG_DWORD', '0')
  regDel('ProxyServer')
  regDel('AutoConfigURL')
  regDel('AutoDetect')
}

function rtFile(name) {
  try { return fs.readFileSync(path.join(RUNTIME, name), 'utf8') } catch { return null }
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } catch { return {} }
}

function makeCtx() {
  const tools = new Map()
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get(key) {
      if (key === 'tools') return { register(d) { tools.set(d.name, d); return () => tools.delete(d.name) } }
      if (key === 'webServer') return { register({ path: p, handler }) { routes.set(p, handler); return () => routes.delete(p) } }
      return undefined
    },
    inject(keys, callback) { if (keys.includes('webServer')) callback(ctx); return () => {} },
    effect(factory) { const d = factory(); return () => { if (typeof d === 'function') d() } },
  }
  return { ctx, tools }
}

async function call(tools, name, payload = {}) {
  const def = tools.get(name)
  if (!def) throw new Error(`工具未注册: ${name}`)
  const out = await def.execute(payload, {})
  return typeof out === 'string' ? out : String(out?.text ?? JSON.stringify(out))
}

async function callJson(tools, name, payload = {}) {
  const def = tools.get(name)
  if (!def) throw new Error(`工具未注册: ${name}`)
  return await def.execute(payload, {})
}

// 等某个条件成立，最多 timeoutMs
async function waitFor(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return true
    if (Date.now() > deadline) return false
    await sleep(700)
  }
}

const baseSplit = readConfig().split || 'cn-direct'
let tools = null

try {
  console.log('=== 系统代理三档 + 守卫 + 中文分流别名 端到端测试 ===')
  console.log(`  代理端口 ${PORT} · 核心端口 ${CORE_PORT} · 守卫间隔 ${GUARD_SEC}s\n`)

  // --- 0. 基线 ---
  console.log('-- 0. 基线 --')
  check(!(await portListening(PORT)) && !(await portListening(CORE_PORT)), '起点两端口空闲')
  const b0 = reg('ProxyEnable')
  console.log(`  基线 ProxyEnable=${b0} ProxyServer=${reg('ProxyServer') || '(不存在)'} AutoConfigURL=${reg('AutoConfigURL') || '(不存在)'}`)

  const mod = await import(`../src/index.js?sysproxy=${Date.now()}`)
  if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) throw new Error('inject 契约被破坏')
  const made = makeCtx()
  tools = made.tools
  mod.apply(made.ctx)
  await sleep(4500) // 等 fire-and-forget 的 reconcile
  check(tools.has('local_proxy_sysproxy'), '第 8 个工具 local_proxy_sysproxy 已注册')

  // --- 1. 代理没起时开系统代理必须被拒绝 ---
  console.log('\n-- 1. 代理未运行时拒绝开系统代理（否则等于自己断网）--')
  const refused = await callJson(tools, 'local_proxy_sysproxy', { mode: 'global' })
  check(refused.ok === false, `拒绝：ok=${refused.ok}`)
  check(/没在运行|start/.test(String(refused.text)), `理由说明清楚：${String(refused.text).split('\n')[0].slice(0, 70)}`)
  check(reg('ProxyEnable') !== '0x1', `注册表未被写入（ProxyEnable=${reg('ProxyEnable')}）`)

  // --- 2. 起代理 ---
  console.log('\n-- 2. 起代理 --')
  const started = await call(tools, 'local_proxy_start', {})
  check(/代理已启动|已在运行/.test(started), `start：${started.split('\n')[0].slice(0, 60)}`)
  check(await waitFor('proxy-port', () => portListening(PORT), 30000), `${PORT} 在监听`)

  // --- 3. pac 档 ---
  console.log('\n-- 3. 系统代理 → pac --')
  const pacRes = await callJson(tools, 'local_proxy_sysproxy', { mode: 'pac', guardSec: GUARD_SEC })
  check(pacRes.ok === true, `pac 切换成功（mode=${pacRes.mode}）`)
  check(reg('ProxyEnable') === '0x1', `ProxyEnable=0x1（实际 ${reg('ProxyEnable')}）`)
  const pacUrl = reg('AutoConfigURL')
  check(Boolean(pacUrl) && /proxy\.pac/i.test(pacUrl || ''), `AutoConfigURL 指向我们的 PAC：${pacUrl}`)
  check(pacUrl === `file:///${path.join(RUNTIME, 'proxy.pac').replace(/\\/g, '/')}`, 'AutoConfigURL 路径与插件 .runtime 完全一致')
  check(reg('ProxyServer') === null, `ProxyServer 已删（PAC 失败时应回落直连而非旧代理），实际 ${reg('ProxyServer') || '(不存在)'}`)
  check(fs.existsSync(SNAPSHOT), '基线快照已采集')
  const snapAfterPac = rtFile('registry-snapshot.json')

  // --- 4. global 档（关键：快照不能被覆盖）---
  console.log('\n-- 4. 系统代理 → global（快照不得被覆盖）--')
  const gRes = await callJson(tools, 'local_proxy_sysproxy', { mode: 'global', guardSec: GUARD_SEC })
  check(gRes.ok === true, `global 切换成功（mode=${gRes.mode}）`)
  check(reg('ProxyServer') === `127.0.0.1:${PORT}`, `ProxyServer=127.0.0.1:${PORT}（实际 ${reg('ProxyServer')}）`)
  check(reg('AutoConfigURL') === null, 'AutoConfigURL 已删（PAC 优先级高于 ProxyServer，留着会架空全局档）')
  check(gRes.snapshot === 'reused', `快照复用而非重采：snapshot=${gRes.snapshot}`)
  check(rtFile('registry-snapshot.json') === snapAfterPac, '快照文件内容逐字节未变（否则还原会还原到我们自己的设置）')

  // --- 5. 守卫证伪：真的把注册表改坏，看它修不修 ---
  console.log('\n-- 5. 守卫证伪 A：外部把 ProxyEnable 关掉 --')
  check(regSet('ProxyEnable', 'REG_DWORD', '0'), '外部改动已写入：ProxyEnable=0（模拟 Windows 自动检测/其它 VPN 抢设置）')
  const fixedA = await waitFor('guard-a', () => reg('ProxyEnable') === '0x1', (GUARD_SEC + 12) * 1000)
  check(fixedA, `守卫在一个周期内写回：ProxyEnable=${reg('ProxyEnable')}`)

  console.log('\n-- 6. 守卫证伪 B：外部把 ProxyServer 指向别处 --')
  check(regSet('ProxyServer', 'REG_SZ', '10.9.8.7:9999'), '外部改动已写入：ProxyServer=10.9.8.7:9999')
  const fixedB = await waitFor('guard-b', () => reg('ProxyServer') === `127.0.0.1:${PORT}`, (GUARD_SEC + 12) * 1000)
  check(fixedB, `守卫写回：ProxyServer=${reg('ProxyServer')}`)

  console.log('\n-- 7. 守卫留痕（status 里能看到巡检与写回次数）--')
  const st1 = await callJson(tools, 'local_proxy_status', {})
  check(/守卫：开着/.test(String(st1.text)), `status 报守卫在跑：${String(st1.text).split('\n').find((l) => l.startsWith('守卫')) || '(无)'}`)
  check(/写回 [1-9]/.test(String(st1.text)), 'status 里写回次数 ≥ 1（证明真的修过，不是空转）')
  check(/最近漂移/.test(String(st1.text)), `漂移内容留痕：${String(st1.text).split('\n').find((l) => l.includes('最近漂移'))?.trim().slice(0, 90) || '(无)'}`)

  // --- 8. off 档：按快照还原 ---
  console.log('\n-- 8. 系统代理 → off（按快照还原到基线）--')
  const offRes = await callJson(tools, 'local_proxy_sysproxy', { mode: 'off' })
  check(offRes.ok === true, `off 成功（mode=${offRes.mode}）`)
  await sleep(800)
  const pe = reg('ProxyEnable')
  check(pe === '0x0' || pe === null, `ProxyEnable 回到基线：${pe || '(不存在)'}`)
  check(reg('ProxyServer') === null, `ProxyServer 已删：${reg('ProxyServer') || '(不存在)'}`)
  check(reg('AutoConfigURL') === null, `AutoConfigURL 已删：${reg('AutoConfigURL') || '(不存在)'}`)
  check(!fs.existsSync(SNAPSHOT), '快照已删（还原成功后不留凭据）')
  const st2 = await callJson(tools, 'local_proxy_status', {})
  check(!/守卫：开着/.test(String(st2.text)), '守卫已停')
  check(st2.baselineOk === true, `baselineOk=${st2.baselineOk}（ProxyEnable=0x0 是 Windows 正常关闭态，不该再报脏）`)

  // --- 9. 代理进程死了，守卫必须自己还原并停摆 ---
  console.log('\n-- 9. 守卫的最后一道防线：代理进程消失 --')
  await callJson(tools, 'local_proxy_sysproxy', { mode: 'pac', guardSec: GUARD_SEC })
  check(reg('ProxyEnable') === '0x1', 'pac 已重新开启（ProxyEnable=0x1）')
  const proxyPid = Number(JSON.parse(rtFile('state.json') || '{}').pid || 0)
  check(proxyPid > 0, `拿到代理 pid ${proxyPid}`)
  if (proxyPid > 0) {
    spawnSync('taskkill', ['/PID', String(proxyPid), '/F'], { windowsHide: true })
    console.log(`  已强杀代理进程 ${proxyPid}，等守卫发现…`)
    const restoredByGuard = await waitFor('guard-restore', () => reg('ProxyEnable') !== '0x1', (GUARD_SEC + 15) * 1000)
    check(restoredByGuard, `守卫发现代理没了 → 自动还原注册表：ProxyEnable=${reg('ProxyEnable') || '(不存在)'}`)
    check(reg('AutoConfigURL') === null, `AutoConfigURL 已清（系统代理绝不指向死端口）：${reg('AutoConfigURL') || '(不存在)'}`)
    const st3 = await callJson(tools, 'local_proxy_status', {})
    check(!/守卫：开着/.test(String(st3.text)), '守卫已自动停摆（不再对着死代理空转）')
    check(!fs.existsSync(SNAPSHOT), '快照已清')
  }

  // --- 10. 中文分流别名 ---
  console.log('\n-- 10. 分流档中文别名（用户说「直连/全局」就该认）--')
  for (const [word, want] of [['全局', 'all'], ['直连', 'direct'], ['规则', 'cn-direct'], ['all', 'all']]) {
    const r = await call(tools, 'local_proxy_switch', { split: word })
    const got = readConfig().split
    check(got === want, `「${word}」→ config.split=${got}（期望 ${want}）`)
  }
  const bad = await call(tools, 'local_proxy_switch', { split: '乱写一个' })
  check(/不认/.test(bad), `不认的词明确报错而非静默兜底：${bad.split('\n').find((l) => l.includes('不认'))?.trim().slice(0, 80) || '(无)'}`)
  check(readConfig().split === 'all', `报错后配置未被改动（仍是上一次的 all，实际 ${readConfig().split}）`)
  await call(tools, 'local_proxy_switch', { split: baseSplit })
  check(readConfig().split === baseSplit, `分流档已复位到 ${baseSplit}`)

  // --- 11. 收尾 ---
  console.log('\n-- 11. 收尾：重新起代理再干净停掉 --')
  await call(tools, 'local_proxy_start', {})
  await waitFor('port2', () => portListening(PORT), 30000)
  const code = await new Promise((resolve) => {
    const child = spawn('curl.exe', ['-s', '-o', 'NUL', '-w', '%{http_code}', '-x', `http://127.0.0.1:${PORT}`, '--max-time', '20', 'https://www.gstatic.com/generate_204'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.once('error', () => resolve('000'))
    child.once('close', () => resolve(out.trim()))
  })
  check(code === '204', `经代理 gstatic → ${code}（期望 204，证明三档折腾完代理仍可用）`)
  await call(tools, 'local_proxy_stop', {})
  await sleep(2500)
  check(!(await portListening(PORT)) && !(await portListening(CORE_PORT)), 'stop 后两端口均释放')
} catch (error) {
  no(`测试异常：${error?.stack || error}`)
} finally {
  // 无论成败：注册表回基线、配置复位、进程清干净。绝不让系统代理留在死端口上。
  restoreBaseline()
  try {
    const cfg = readConfig()
    if (cfg.split !== baseSplit) fs.writeFileSync(CONFIG, `${JSON.stringify({ ...cfg, split: baseSplit }, null, 2)}\n`, 'utf8')
  } catch {}
  spawnSync('node', [path.join(ROOT, 'bin', 'singbox-node.js'), 'stop', '--port', String(CORE_PORT)], {
    cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  console.log('\n-- finally 兜底 --')
  console.log(`  ProxyEnable=${reg('ProxyEnable') || '(不存在)'} ProxyServer=${reg('ProxyServer') || '(不存在)'} AutoConfigURL=${reg('AutoConfigURL') || '(不存在)'}`)
  console.log(`  config.split 复位为 ${readConfig().split}`)
}

console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} → ${fail === 0 ? 'PASS' : 'FAIL'} ===`)
process.exit(fail === 0 ? 0 : 1)
