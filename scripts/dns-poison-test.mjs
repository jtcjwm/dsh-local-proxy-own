// dns-poison-test.mjs - 抗污染回归测试：把 2026-10-22 07:00 的实测结论钉死。
//
// 那次实测四组对照（本机·烟台移动 DNS 211.137.191.26）：
//   本地 DNS   www.google.com → 2001::1 + 69.171.235.22（2001::1 是典型污染注入）
//              www.facebook.com → 2001::1 + 157.240.7.20
//              www.youtube.com → 2001::1 + 174.132.167.252
//   直连访问   三个域名全 000 / exit=28（8s 超时）
//   经代理     google 204(0.349s) · facebook 200(0.914s) · youtube 200(0.795s)
//   出口 IP    直连 烟台移动 111.15.93.33 → 经代理 新加坡 13.212.177.113
//
// 结论：**本地解析结果是假的、直连全死，经代理却全通 ⇒ 核心没有使用本地 DNS
// 的解析结果，域名以原名交给远端节点解析**。所以抗污染不靠「加一个 DoH 上游」，
// 而靠「根本不解析」。
//
// 本测试 therefore 有两层：
//   A. 行为层 —— 复现四组对照，任何一层退化都会被抓到
//   B. 配置层 —— 断言生成的 sing-box.json 里没有 dns 段、没有 domain_strategy、
//      没有 geoip/rule_set。这三样任何一个被"好心"加进去，sing-box 就会开始
//      用被污染的本地 DNS 解析，A 层随即崩塌。B 层是 A 层的病因探测器。
//
//   node scripts/dns-poison-test.mjs [--port 17899]
//
// 退出码 0 才算全通过。需要代理在运行（没跑就自己起、测完自己停）。
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RUNTIME = path.join(ROOT, '.runtime')
const CORE_PORT = 18999

const argv = process.argv.slice(2)
const PORT = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 17899

// 已知被污染的域名。判定不写死具体假 IP（污染值会变），而是看特征。
const POISONED = ['www.google.com', 'www.facebook.com', 'www.youtube.com']
// 国内站：必须走直连（不进隧道），用延迟而非状态码判分流。
const CN_SITES = ['https://www.baidu.com', 'https://www.bilibili.com']

// 「同数量级」判定：绝对差 < 1.5s，或不超过直连值的 3 倍（取宽松的那个）。
// 走隧道是绕到新加坡/荷兰再回来，通常多花 1~5s，远超国内直连的抖动范围。
// 不用绝对阈值：bilibili 自己偶发慢（2026-10-22 07:40 实测 5.1s）时，绝对阈值
// 会误报，而且它分不清「站点慢」和「真进了隧道」——后者才是这里要抓的。
const sameOrder = (proxySecs, directSecs) => {
  if (!(proxySecs > 0) || !(directSecs >= 0)) return false
  return Math.abs(proxySecs - directSecs) < Math.max(1.5, directSecs * 2)
}

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

/** 本地 DNS 对一个域名解析出的全部地址（nslookup 原文解析）。 */
async function localResolve(domain) {
  try {
    const { stdout } = await execFileAsync('nslookup', [domain], { windowsHide: true, timeout: 15000 })
    const text = String(stdout)
    // nslookup 的多地址输出只有首行带 "Addresses:" 前缀，后续地址是纯缩进行；
    // 而且中文版 Windows 把 "Name:" 译成 "名称:"，所以既不能按行匹配前缀，也
    // 不能靠英文字段名定位答案块。输出结构是固定的「服务器块 + 空行 + 答案块」，
    // 按空行切分与语言无关。行尾在中文机上可能是 \r\r\n，先归一。
    const clean = text.replace(/\r+/g, '\n').replace(/\n{2,}/g, '\n\n')
    const blocks = clean.split('\n\n')
    const body = blocks.length > 1 ? blocks.slice(1).join('\n') : clean
    const addrs = []
    for (const m of body.matchAll(/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F]*:[0-9a-fA-F:]+)/g)) {
      const a = m[1]
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a) || a.includes(':')) addrs.push(a)
    }
    return { raw: text, server: (clean.match(/Address(?:es)?:\s*(\S+)/) || [])[1] || null, addrs: [...new Set(addrs)] }
  } catch (error) {
    return { raw: String(error?.stdout || error?.message || ''), server: null, addrs: [] }
  }
}

/** curl 一次，返回 {code, secs, exit}。proxy 为 null 表示强制直连。 */
async function fetch(url, proxy, maxTime = 12) {
  const args = ['-s', '-o', 'NUL', '-w', '%{http_code} %{time_total}', '--max-time', String(maxTime)]
  if (proxy) args.push('-x', `http://127.0.0.1:${proxy}`)
  else args.push('--noproxy', '*')
  args.push(url)
  const t0 = Date.now()
  try {
    const { stdout } = await execFileAsync('curl.exe', args, { windowsHide: true, timeout: (maxTime + 8) * 1000 })
    const [code, secs] = String(stdout).trim().split(/\s+/)
    return { code: code || '000', secs: Number(secs) || 0, exit: 0, ms: Date.now() - t0 }
  } catch (error) {
    const out = String(error?.stdout || '').trim()
    const [code, secs] = out.split(/\s+/)
    return { code: code || '000', secs: Number(secs) || 0, exit: error?.code ?? 1, ms: Date.now() - t0 }
  }
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

let startedByUs = false
let tools = null

try {
  console.log('=== 抗污染回归测试（行为层 + 配置层）===')
  console.log(`  代理端口 ${PORT} · 核心端口 ${CORE_PORT} · 被测域名 ${POISONED.join(', ')}\n`)

  // --- 0. 代理必须在跑；没跑就自己起，测完自己停 ---
  if (!(await portListening(PORT))) {
    console.log('-- 0. 代理未运行，本测试自行启动 --')
    const mod = await import(`../src/index.js?dnspoison=${Date.now()}`)
    const made = makeCtx()
    tools = made.tools
    mod.apply(made.ctx)
    await sleep(4500)
    const def = tools.get('local_proxy_start')
    const r = await def.execute({}, {})
    check(/代理已启动|已在运行/.test(String(r?.text || '')), `start：${String(r?.text || '').split('\n')[0].slice(0, 60)}`)
    const up = await (async () => {
      const dl = Date.now() + 40000
      while (Date.now() < dl) { if (await portListening(PORT)) return true; await sleep(600) }
      return false
    })()
    check(up, `${PORT} 已监听`)
    startedByUs = true
    if (!up) throw new Error('代理起不来，后续测试无意义')
  } else {
    console.log('-- 0. 代理已在运行（复用，测完不动它）--')
    ok(`${PORT} 在监听`)
  }

  // --- A1. 本地 DNS 确实被污染（这是整个测试的前提）---
  console.log('\n-- A1. 本地 DNS 污染取证 --')
  let poisonedCount = 0
  for (const d of POISONED) {
    const r = await localResolve(d)
    // 污染特征：2001::1（最常见的注入假地址）、或一个域名返回多个互不相干的地址
    const hasFakeV6 = r.addrs.some((a) => /^2001::/i.test(a) || /^::/i.test(a) && a !== '::1')
    const suspicious = hasFakeV6 || r.addrs.length >= 2
    if (suspicious) poisonedCount++
    console.log(`    ${d} → ${r.addrs.join(', ') || '(无应答)'}${hasFakeV6 ? '  ← 含 2001:: 假地址' : ''}`)
    check(suspicious, `${d} 本地解析结果可疑（污染前提成立）`)
  }
  if (poisonedCount === 0) {
    console.log('    ⚠ 本地 DNS 此刻没有表现出污染。A2/A3 的对照仍然有效，')
    console.log('      但「污染被绕过」这一条本轮无法证明——属环境时点问题，不是代码退化。')
  }

  // --- A2. 直连必须失败（对照组）---
  console.log('\n-- A2. 直连访问（对照组，应失败）--')
  const directResults = []
  for (const d of POISONED) {
    const r = await fetch(`https://${d}/`, null, 8)
    directResults.push(r)
    console.log(`    https://${d}/ → ${r.code} ${r.secs}s exit=${r.exit}`)
  }
  const directAllDead = directResults.every((r) => r.code === '000' || Number(r.code) >= 400)
  check(directAllDead, `直连 ${directResults.filter((r) => r.code === '000').length}/${POISONED.length} 个域名拿不到响应（污染生效中）`)

  // --- A3. 经代理必须成功（决定性证据）---
  console.log('\n-- A3. 经代理访问（本地解析是假的却仍然通 ⇒ 没用本地 DNS）--')
  const g = await fetch('https://www.gstatic.com/generate_204', PORT, 20)
  check(g.code === '204', `gstatic generate_204 → ${g.code}（${g.secs}s）`)
  let proxyOk = 0
  for (const d of POISONED) {
    const r = await fetch(`https://${d}/`, PORT, 20)
    const good = Number(r.code) >= 200 && Number(r.code) < 400
    if (good) proxyOk++
    console.log(`    https://${d}/ → ${r.code} ${r.secs}s`)
    check(good, `${d} 经代理可达（${r.code}），而直连是 ${directResults[POISONED.indexOf(d)]?.code}`)
  }
  check(proxyOk === POISONED.length, `全部 ${proxyOk}/${POISONED.length} 个被污染域名经代理可达`)
  // 这条是整个第 3 组的核心结论
  check(directAllDead && proxyOk === POISONED.length,
    '核心结论成立：直连全死 + 经代理全通 ⇒ 域名以原名交远端解析，本地被污染的 A/AAAA 记录未被使用')

  // --- A4. 出口确实在境外 ---
  console.log('\n-- A4. 出口 IP 对照 --')
  try {
    const { stdout: direct } = await execFileAsync('curl.exe', ['-s', '--noproxy', '*', '--max-time', '12', 'https://myip.ipip.net'], { windowsHide: true })
    const { stdout: proxied } = await execFileAsync('curl.exe', ['-s', '-x', `http://127.0.0.1:${PORT}`, '--max-time', '20', 'https://myip.ipip.net'], { windowsHide: true })
    console.log(`    直连: ${direct.trim()}`)
    console.log(`    代理: ${proxied.trim()}`)
    check(/中国/.test(direct), '直连出口仍在国内（本机没有全局接管）')
    check(!/中国/.test(proxied) && proxied.trim().length > 0, `经代理出口在境外：${proxied.trim().slice(0, 60)}`)
  } catch (error) {
    no(`出口查询失败：${error.message}`)
  }

  // --- A5. 国内站必须走直连（不该进隧道）---
  console.log('\n-- A5. 国内站分流正确性（对照组判定，不用绝对阈值）--')
  for (const u of CN_SITES) {
    // 先测直连延迟作为对照：只有「经代理 ≈ 直连」才证明这条流量没进隧道。
    const direct = await fetch(u, null, 15)
    let r = await fetch(u, PORT, 15)
    // 单次测量受抖动影响；第一次可疑就隔 0.8s 复测一次，取较快的那次
    // （较快的更接近真实直连水平，慢的那次多半是站点或链路瞬时抖动）。
    if (!sameOrder(r.secs, direct.secs)) {
      await new Promise((res) => setTimeout(res, 800))
      const r2 = await fetch(u, PORT, 15)
      if (r2.secs > 0 && r2.secs < r.secs) r = r2
    }
    check(r.code === '200' && sameOrder(r.secs, direct.secs),
      `${u} → 经代理 ${r.code} ${r.secs}s vs 直连 ${direct.code} ${direct.secs}s（同数量级 ⇒ 国内直连未进隧道）`)
  }

  // --- B. 配置层：病因探测器 ---
  console.log('\n-- B. 配置层断言（防止将来"好心"把污染路径加回来）--')
  const cfgPath = path.join(RUNTIME, 'sing-box.json')
  // rtRead 内部自己拼 RUNTIME，只能传文件名；传完整路径会拼成非法路径而误报"读不到"
  const cfgRaw = rtRead('sing-box.json')
  if (cfgRaw === null) {
    no(`读不到 ${cfgPath}（核心在跑就该有这个文件）`)
  } else {
    const cfg = JSON.parse(cfgRaw)
    check(cfg.dns === undefined, `配置里没有 dns 段（有 dns 段 = sing-box 开始自己解析 = 吃本地污染）${cfg.dns ? '：' + JSON.stringify(cfg.dns).slice(0, 120) : ''}`)
    const outs = JSON.stringify(cfg.outbounds || [])
    check(!/domain_strategy/.test(outs), 'outbounds 里没有 domain_strategy（默认 as_is 才会把域名原名交给远端；设成 prefer_ipv4/ipv6_only 就会本地解析）')
    const routeRaw = JSON.stringify(cfg.route || {})
    check(!/geoip|rule_set|geosite/.test(routeRaw), 'route 里没有 geoip/geosite/rule_set（IP 类规则需要先解析域名，一解析就吃污染；且外部规则集会腐烂）')
    // 正面断言：cn-direct 档必须是纯域名规则
    const rules = cfg.route?.rules || []
    const domainRule = rules.find((r) => Array.isArray(r.domain_suffix))
    check(Boolean(domainRule), `国内直连用的是 domain_suffix 规则（${domainRule?.domain_suffix?.length || 0} 条后缀），匹配时不解析`)
    check(rules.some((r) => r.ip_is_private === true), '内网地址用 ip_is_private 直连（也不需要解析）')
    check(typeof cfg.route?.final === 'string' && cfg.route.final.length > 0, `final 出站 = ${cfg.route?.final}（域名规则没命中的全进隧道）`)
  }

  // PAC 也必须是纯域名判断
  const pacRaw = rtRead('proxy.pac')
  if (pacRaw) {
    // 不能匹配 "dns" 子串：CN_SUFFIXES 里就有 dnspod.cn，会自己打自己。
    // 只匹配真正的解析 API 调用。
    check(!/\bgetHostByName\b|\bdns\s*[.(]|\bresolve\s*\(|\blookupHost\b/i.test(pacRaw), 'PAC 脚本里没有任何解析 API 调用（浏览器按域名字符串判断，污染无从介入）')
    check(/CN_SUFFIXES/.test(pacRaw) && /FindProxyForURL/.test(pacRaw), 'PAC 用内置后缀表 + FindProxyForURL，运行时不联网取规则')
  } else {
    console.log('    (proxy.pac 不在，跳过 PAC 断言)')
  }
} catch (error) {
  no(`测试异常：${error?.stack || error}`)
} finally {
  if (startedByUs && tools) {
    try {
      const def = tools.get('local_proxy_stop')
      if (def) await def.execute({}, {})
      console.log('\n-- finally：本测试自行起的代理已停掉 --')
    } catch (error) {
      console.log(`\n-- finally：停代理失败 ${error.message}，请手工 local_proxy_stop --`)
    }
  } else {
    console.log('\n-- finally：代理是复用的，保持运行不动它 --')
  }
}

function rtRead(name) {
  try { return fs.readFileSync(path.join(RUNTIME, name), 'utf8') } catch { return null }
}

console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} → ${fail === 0 ? 'PASS' : 'FAIL'} ===`)
process.exit(fail === 0 ? 0 : 1)
