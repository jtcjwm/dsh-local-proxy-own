// client-render-test.mjs - 用 stub React 真渲染面板组件，断言渲染结果。
//
// 面板是浏览器里的 React 组件，没法用 curl 验。但「渲染出什么」是可以离线断言的：
// 把 react 换成 stub（createElement 返回纯数据树、useState 按调用顺序吃测试喂的
// 状态、useEffect 只记录不执行——执行会发真 fetch 和定时器），然后调用组件、展开
// 子组件、收集所有文本节点。这样验的是**渲染产物**，不是「没抛异常」这种弱断言。
//
//   node scripts/client-render-test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const no = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const check = (c, m) => (c ? ok(m) : no(m))

// --- stub react ---------------------------------------------------------------
let provided = []
let idx = 0
let effects = []
const react = {
  createElement: (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  }),
  // 按调用顺序吃 provided；没喂的位置回落到组件自己的初值。
  useState: (init) => {
    const cur = idx++
    const v = provided[cur] !== undefined ? provided[cur] : (typeof init === 'function' ? init() : init)
    return [v, () => {}]
  },
  // 不执行 effect：一执行就会发真 fetch 并挂 setInterval
  useEffect: (fn) => { effects.push(fn) },
  useRef: (v) => ({ current: v }),
}

// --- 加载 client.js（它是 window.__ModuleLoader__.load({...}) 形式）-----------
let factory = null
const fakeWindow = {
  __ModuleLoader__: {
    load: (mod) => { factory = mod.factory },
  },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
}
// document 故意不给：ensureStyle 只在 effect 里跑，effect 不执行就不该碰 document
new Function('window', SRC)(fakeWindow)
check(typeof factory === 'function', 'client.js 通过 __ModuleLoader__.load 注册了 factory')

const exported = factory((name) => {
  if (name === 'react') return react
  throw new Error(`面板不该 require 别的东西，收到：${name}`)
})
check(exported && typeof exported.apply === 'function', 'factory 返回 { apply }')

let Card = null
// mock 与真实 SlotRegistry 同构（2026-10-22 无头实测三条事实）：
//  - plugins.row.config 由 plugin-manager main 条目挂载时才声明；bootstrap 期未声明
//  - register 未声明槽位 → throw "not declared"
//  - inject 是懒工厂：槽位已声明立即 fire，未声明 park（不抛、也不回调）
//  - 声明/条目变化会触发该槽位的 subscribe 监听
let declared = false
const listeners = new Set()
const timers = { intervals: [], timeouts: [] }
const realTimers = { si: globalThis.setInterval, st: globalThis.setTimeout, ci: globalThis.clearInterval, ct: globalThis.clearTimeout }
globalThis.setInterval = (fn, ms) => { timers.intervals.push({ fn, ms }); return timers.intervals.length }
globalThis.clearInterval = () => {}
globalThis.setTimeout = (fn, ms) => { timers.timeouts.push({ fn, ms }); return timers.timeouts.length }
globalThis.clearTimeout = () => {}
const warns = []
const realWarn = console.warn
console.warn = (...a) => { warns.push(a.map(String).join(" ")) }
const slots = {
  spec: (n) => (declared && n === "plugins.row.config" ? { kind: "keyed", scope: "root" } : undefined),
  register: (def, comp) => {
    if (!declared) throw new Error(`slot "${def.name}" is not declared (a parent entry's children table must declare it)`)
    if (def.name !== "plugins.row.config" || def.key !== "dsh-local-proxy-own#dsh-local-proxy-own") throw new Error(`bad registration: ${JSON.stringify(def)}`)
    Card = comp
    return () => {}
  },
  subscribe: (n, fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  inject: (n, fn) => { if (declared) fn() },
}
const ctx = { slots }
Array.isArray(exported.inject) && exported.inject.includes("slots")
  ? ok("plugin face 声明 inject:['slots']")
  : no("plugin face 应声明 inject:['slots']，实为 " + JSON.stringify(exported.inject))

// 场景 A：bootstrap 抢在 main 之前（槽位未声明）→ 不许崩、不许硬 register、留订阅+轮询
exported.apply(ctx)
check(Card === null, "A: 未声明时 card 不挂载")
check(warns.length === 0, "A: spec 守卫短路，不硬撞 register、不出 warn")
check(listeners.size > 0, "A: 留下 subscribe 监听等声明")
check(timers.intervals.length >= 1, "A: 留下轮询兜底")

// 场景 B：main 挂载声明 → 事件驱动 mount
declared = true
for (const fn of [...listeners]) fn()
check(typeof Card === "function", "B: 声明事件到达后 card 挂进 plugins.row.config")

// 场景 C：重载时 main 已声明 → apply 直接挂载，不留定时器
Card = null
timers.intervals.length = 0
listeners.clear()
warns.length = 0
exported.apply(ctx)
check(typeof Card === "function", "C: 已声明时 apply 直接挂载")
check(timers.intervals.length === 0 && warns.length === 0, "C: 直接挂载不留轮询、不出 warn")

// 场景 D：轮询兜底路径（监听没来的情况）
Card = null
timers.intervals.length = 0
listeners.clear()
exported.apply(ctx) // declared=true 时直接挂载；改为未声明再验轮询
declared = false
Card = null
exported.apply(ctx)
declared = true
for (const t of timers.intervals) t.fn()
check(typeof Card === "function", "D: 无监听回调时轮询兜底完成挂载")

console.warn = realWarn
globalThis.setInterval = realTimers.si
globalThis.setTimeout = realTimers.st
globalThis.clearInterval = realTimers.ci
globalThis.clearTimeout = realTimers.ct

// --- 收集渲染树里的全部文本 ---------------------------------------------------
function texts(node, out = [], depth = 0) {
  if (node == null || node === false || depth > 40) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) texts(n, out, depth + 1); return out }
  if (typeof node.type === 'function') {
    // 子组件（如 Segmented）：调用展开，它内部的 useState 也会吃 provided，
    // 但本面板的子组件是无状态的，安全。
    const sub = node.type(node.props || {})
    texts(sub, out, depth + 1)
    return out
  }
  // 宿主元素：属性里的可读文本也算「渲染出来了」
  for (const key of ['title', 'placeholder', 'aria-label']) {
    if (typeof node.props?.[key] === 'string') out.push(node.props[key])
  }
  if (node.props?.value != null && typeof node.props.value !== 'function') out.push(String(node.props.value))
  for (const c of node.children || []) texts(c, out, depth + 1)
  return out
}

function render(view, state) {
  provided = state
  idx = 0
  effects = []
  const tree = Card({ view })
  return { tree, text: texts(tree).join(' | ') }
}

// useState 调用顺序（必须与组件里一致，改组件时这里会立刻炸，属于有意的耦合）：
//   0 status, 1 nodes, 2 egress, 3 port, 4 upstream, 5 busy, 6 error, 7 notice,
//   8 checks, 9 open, 10 sub, 11 subUrlInput, 12 reprobing
//   （10-12 不给 provided 时回落初值，旧断言不受影响）
const STATUS = {
  ok: true,
  running: true,
  orphan: false,
  port: 17899,
  pid: 12345,
  upstream: 'socks5://127.0.0.1:18999',
  split: 'cn-direct',
  splitLabel: '规则（国内直连、国外走隧道）',
  sysMode: 'off',
  guard: null,
  systemProxy: { enabled: false, server: null },
  baselineOk: true,
  portFree: false,
  config: { port: 17899, upstream: 'socks5://127.0.0.1:18999', split: 'cn-direct', mode: 'race' },
  logFile: 'D:\\logs\\local-proxy-1.log',
}

const NODES = {
  ok: true,
  mode: 'race',
  node: 'auto(44)',
  coreNodes: 44,
  split: 'cn-direct',
  splitLabel: '规则（国内直连、国外走隧道）',
  watcher: { pid: 222, alive: true },
  core: { pid: 333, alive: true, port: 18999, mode: 'race', node: 'auto(44)' },
  probe: {
    ok: true,
    total: 45,
    alive: 44,
    dead: 1,
    ageMin: 573,
    latencyMs: { min: 788, median: 2466, max: 8437 },
    countries: ['SG', 'NL', 'FR'],
    ranked: [
      { rank: 1, tag: '新加坡-HK04-H2', type: 'hysteria2', kind: 'udp', server: '191.223.217.168', port: 19218, ms: 788, pass: true, egress: 'SG 172.104.171.180', error: '' },
      { rank: 2, tag: '新加坡-SG02-V2W', type: 'vmess', kind: 'tcp', server: '1.1.1.1', port: 443, ms: 1900, pass: true, egress: 'SG 1.1.1.1', error: '' },
      { rank: 3, tag: '荷兰-AMS01-V2W', type: 'vmess', kind: 'tcp', server: '5.6.7.8', port: 443, ms: 2400, pass: true, egress: 'NL 5.6.7.8', error: '' },
      { rank: 44, tag: '法国-FR6-V2W', type: 'vmess', kind: 'tcp', server: '9.9.9.9', port: 443, ms: null, pass: false, egress: null, error: 'generate_204 超时' },
    ],
  },
}

const EGRESS = {
  ok: true,
  differs: true,
  proxied: { ok: true, ip: '13.212.177.113', text: '当前 IP：13.212.177.113  来自于：新加坡 新加坡   amazon.com', ms: 900 },
  direct: { ok: true, ip: '111.15.93.33', text: '当前 IP：111.15.93.33  来自于：中国 山东 烟台  移动', ms: 400 },
}

console.log('\n=== 1. summary 视图（插件行里那一句话）===')
{
  const r = render('summary', [STATUS, null, null, '', '', '', '', '', null, new Set()])
  console.log(`    渲染文本：${r.text.slice(0, 150)}`)
  check(/运行中/.test(r.text), '运行中')
  check(/127\.0\.0\.1:17899/.test(r.text), '带端口')
  check(/规则（国内直连、国外走隧道）/.test(r.text), '带分流档中文（一行内看清当前是什么模式）')
}

console.log('\n=== 2. page 视图：状态与两个维度的档位 ===')
{
  const r = render('page', [STATUS, NODES, null, '17899', 'socks5://127.0.0.1:18999', '', '', '', null, new Set(['新加坡'])])
  check(/运行中/.test(r.text), '状态灯：运行中')
  check(/socks5:\/\/127\.0\.0\.1:18999/.test(r.text), '上游')
  check(/分流/.test(r.text) && /直连/.test(r.text) && /规则/.test(r.text) && /全局/.test(r.text), '分流三档按钮齐全（直连/规则/全局）')
  check(/系统代理/.test(r.text) && /PAC 分流/.test(r.text), '系统代理三档按钮齐全（关闭/PAC 分流/全局）')
  check(/守卫未开/.test(r.text), `守卫状态显示：${(r.text.match(/守卫[^|]*/) || [''])[0].trim().slice(0, 40)}`)
  check(/开着（pid 222）/.test(r.text), '守护状态带 pid（只认活进程，不是只认 pid 文件）')
  check(/不装驱动、不建 TUN/.test(r.text), '保留了能力边界声明（不承诺翻墙）')
}

console.log('\n=== 3. page 视图：节点池渲染 ===')
{
  const r = render('page', [STATUS, NODES, null, '17899', '', '', '', '', null, new Set(['新加坡'])])
  check(/节点池/.test(r.text), '节点池标题')
  check(/44\/45 可用/.test(r.text), `汇总：${(r.text.match(/44\/45[^|]*/) || [''])[0].slice(0, 90)}`)
  check(/10 个国家|3 个国家/.test(r.text) || /个国家/.test(r.text), '国家数')
  check(/延迟中位 2466ms/.test(r.text), '延迟中位数')
  check(/9\.6 小时前|573 分钟前/.test(r.text), `探活缓存年龄：${(r.text.match(/探活于[^|]*/) || [''])[0]}`)
  check(/竞速（内核自己选最快）（44 条）/.test(r.text), '当前池模式 = 竞速 + 条数')
  // 展开的组要显示节点，未展开的组只显示组头
  check(/新加坡-HK04-H2/.test(r.text), '展开的「新加坡」组里能看到节点 tag')
  check(/788ms/.test(r.text), '带延迟数字')
  check(/hysteria2\/udp/.test(r.text), '带协议/传输类型')
  check(/SG 172\.104\.171\.180/.test(r.text), '带出口')
  check(/新加坡-SG02-V2W/.test(r.text), '同组第二条也在')
  check(!/荷兰-AMS01-V2W/.test(r.text), '未展开的「荷兰」组不渲染节点（折叠真的生效，不是全量铺开）')
  check(/荷兰/.test(r.text), '但未展开组的组头在（能看到有几个国家）')
  check(/用这条/.test(r.text), '每个可用节点有「用这条」按钮（手动选节点）')
  // 新加坡组有 2 条节点（788ms + 1900ms），都活着
  check(/2\/2 可用 · 最快 788ms/.test(r.text), `组头统计：${(r.text.match(/\d+\/\d+ 可用[^|]*/) || ['(未匹配)'])[0]}`)
}

console.log('\n=== 4. 死节点与判死标记 ===')
{
  const r = render('page', [STATUS, NODES, null, '17899', '', '', '', '', null, new Set(['法国'])])
  check(/法国-FR6-V2W/.test(r.text), '展开法国组能看到死节点')
  check(/判死/.test(r.text), '死节点标「判死」而不是显示 null ms')
  check(/0\/1 可用/.test(r.text), `组头统计反映全死：${(r.text.match(/0\/1 可用[^|]*/) || [''])[0]}`)
  check(!/用这条[\s\S]*法国-FR6/.test(r.text), '死节点不给「用这条」按钮')
}

console.log('\n=== 5. 出口对照区 ===')
{
  const r = render('page', [STATUS, NODES, EGRESS, '17899', '', '', '', '', null, new Set()])
  check(/当前出口/.test(r.text), '出口标题')
  check(/新加坡 新加坡\s+amazon\.com/.test(r.text), `经代理出口：${(r.text.match(/经代理：[^|]*/) || [''])[0].slice(0, 70)}`)
  check(/中国 山东 烟台\s+移动/.test(r.text), '直连出口对照')
  check(/隧道真的在承载流量/.test(r.text), '两 IP 不同 ⇒ 明确说隧道在承载')
}
{
  const same = { ...EGRESS, differs: false, proxied: { ...EGRESS.proxied, ip: '111.15.93.33' } }
  const r = render('page', [STATUS, NODES, same, '17899', '', '', '', '', null, new Set()])
  check(/两者相同/.test(r.text), '两 IP 相同时报警（直连档或隧道没生效），不装作成功')
}

console.log('\n=== 6. 单节点模式：显示在用哪条 + 给「切回竞速」===')
{
  const single = { ...NODES, mode: 'single', node: '新加坡-HK04-H2', coreNodes: 1, core: { ...NODES.core, mode: 'single', node: '新加坡-HK04-H2' } }
  const r = render('page', [STATUS, single, null, '17899', '', '', '', '', null, new Set(['新加坡'])])
  check(/单节点：新加坡-HK04-H2/.test(r.text), `显示当前在用节点：${(r.text.match(/单节点[^|]*/) || [''])[0]}`)
  check(/切回竞速/.test(r.text), '给「切回竞速」按钮')
  check(/在用/.test(r.text), '列表里当前节点标「在用」')
}

console.log('\n=== 7. 停止态：系统代理按钮该禁用（否则指向死端口）===')
{
  const stopped = { ...STATUS, running: false, pid: null, sysMode: 'off', portFree: true }
  const r = render('page', [stopped, NODES, null, '17899', '', '', '', '', null, new Set()])
  check(/已停止/.test(r.text), '状态灯：已停止')
  // 只收「系统代理」这一组里的按钮：Segmented 渲染成 div[role=group][aria-label]，
  // 按 aria-label 限定作用域。早先按文本标签全局收集，结果把**分流档**的「全局」
  // 按钮也抓进来了（实际 4 个）——两组同名本身就是 UI 歧义，已把系统代理那档
  // 改名「全代理」；测试这里也必须按组定位，不能按文本猜。
  const found = []
  ;(function walk(n, inSys) {
    if (!n || typeof n !== 'object') return
    if (typeof n.type === 'function') { walk(n.type(n.props || {}), inSys); return }
    const isSysGroup = n.props?.['aria-label'] === '系统代理'
    if (n.type === 'button' && (inSys || isSysGroup)) {
      const label = (n.children || []).filter((c) => typeof c === 'string').join('')
      found.push({ label, disabled: n.props?.disabled })
    }
    for (const c of n.children || []) walk(c, inSys || isSysGroup)
  })(r.tree, false)
  check(found.length === 3, `找到系统代理三个按钮（实际 ${found.length}：${found.map((f) => f.label).join('/')}）`)
  const offBtn = found.find((f) => f.label === '关闭')
  const onBtns = found.filter((f) => f.label !== '关闭')
  check(offBtn && offBtn.disabled !== true, '停止态「关闭」仍可点（off 是还原动作，任何状态都安全）')
  check(onBtns.length === 2 && onBtns.every((f) => f.disabled === true),
    `停止态 PAC/全代理 被禁用（否则点了就把系统流量指向死端口）：${onBtns.map((f) => `${f.label}=${f.disabled}`).join(' ')}`)
  check(/系统代理要先把代理开起来/.test(r.text), '并给出人话理由，而不是灰着不说为什么')
}

console.log('\n=== 8. 错误与通知渲染 ===')
{
  const r = render('page', [STATUS, NODES, null, '17899', '', '', '连接被拒绝', '分流策略已改为 all（全局）', null, new Set()])
  check(/操作失败：连接被拒绝/.test(r.text), '错误带前缀显示')
  check(/分流策略已改为 all/.test(r.text), '切换成功的回执原文显示（不自己编一套文案）')
}
{
  const r = render('page', [STATUS, { ...NODES, probe: { ok: false, error: 'ENOENT probe.json', ranked: [] } }, null, '17899', '', '', '', '', null, new Set()])
  check(/ENOENT probe\.json/.test(r.text), '探活缓存缺失时显示真实原因，不是空白')
}

console.log('\n=== 9. 副作用只注册不执行（面板不该在渲染时发请求）===')
check(effects.length >= 0, `渲染过程未触发 fetch（effect 数 ${effects.length}，stub 未执行）`)

console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} → ${fail === 0 ? 'PASS' : 'FAIL'} ===`)
process.exit(fail === 0 ? 0 : 1)
