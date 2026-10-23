// routes-probe.mjs - 直接调面板路由的 handler，验三条新路由真的返回正确 JSON。
// 不走 HTTP、不动宿主：mock req/res 即可，因为 sendJson 只用 writeHead + end。
import path from 'node:path'

const ROOT = 'D:/DSH/plugins/dsh-local-proxy-own'
const tools = new Map()
const routes = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ctx = {
  logger: { warn: () => {}, info: () => {}, error: () => {} },
  get(key) {
    if (key === 'tools') return { register(d) { tools.set(d.name, d); return () => tools.delete(d.name) } }
    if (key === 'webServer') return { register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }
    return undefined
  },
  inject(keys, cb) { if (keys.includes('webServer')) cb(ctx); return () => {} },
  effect(factory) { const d = factory(); return () => { if (typeof d === 'function') d() } },
}

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(code) { this.statusCode = code },
    end(data) { this.body = data },
  }
}

function mockReq(method, body) {
  return {
    method,
    headers: { host: '127.0.0.1:1870', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    // readJsonBody 需要可读流；switch 用它取 body
    [Symbol.asyncIterator]: undefined,
    _body: body,
  }
}

let pass = 0
let fail = 0
const check = (c, m) => { if (c) { pass++; console.log(`  PASS  ${m}`) } else { fail++; console.log(`  FAIL  ${m}`) } }

const mod = await import(`file:///${ROOT}/src/index.js?routesprobe=${Date.now()}`)
mod.apply(ctx)
await sleep(4500) // 等 fire-and-forget 的 reconcile

console.log('=== 面板路由注册情况 ===')
console.log(`  路由总数 ${routes.size}：`)
for (const p of routes.keys()) console.log(`    ${p}`)
check(routes.has('/dsh-local-proxy-own/nodes'), '/nodes 已注册')
check(routes.has('/dsh-local-proxy-own/egress'), '/egress 已注册')
check(routes.has('/dsh-local-proxy-own/switch'), '/switch 已注册')
check(routes.size === 7, `路由数 4 → 7（实际 ${routes.size}）`)

console.log('\n=== GET /nodes ===')
{
  const res = mockRes()
  await routes.get('/dsh-local-proxy-own/nodes')(mockReq('GET'), res)
  check(res.statusCode === 200, `HTTP ${res.statusCode}`)
  const d = JSON.parse(res.body || '{}')
  console.log(`  ok=${d.ok} mode=${d.mode} split=${d.split}(${d.splitLabel}) probe.ok=${d.probe?.ok}`)
  console.log(`  节点 ${d.probe?.alive}/${d.probe?.total}（缓存 ${d.probe?.ageMin} 分钟前）国家 ${(d.probe?.countries || []).join(',')}`)
  console.log(`  watcher=${JSON.stringify(d.watcher)} core=${JSON.stringify(d.core)}`)
  console.log(`  ranked[0]=${JSON.stringify(d.probe?.ranked?.[0])}`)
  check(d.ok === true, 'ok=true')
  check(Array.isArray(d.probe?.ranked) && d.probe.ranked.length > 0, `ranked 有 ${d.probe?.ranked?.length} 条`)
  const r0 = d.probe?.ranked?.[0] || {}
  check(typeof r0.tag === 'string' && typeof r0.ms === 'number' && typeof r0.pass === 'boolean', 'ranked 条目含 tag/ms/pass（面板要的三样）')
  check(typeof d.splitLabel === 'string' && d.splitLabel.length > 0, `splitLabel 有中文说明：${d.splitLabel}`)
  check(d.probe?.ranked?.every((n) => typeof n.rank === 'number'), '每条带 rank（面板按序显示）')
}

console.log('\n=== GET /nodes 方法约束 ===')
{
  const res = mockRes()
  await routes.get('/dsh-local-proxy-own/nodes')(mockReq('POST'), res)
  check(res.statusCode === 405, `POST → ${res.statusCode}（应 405）`)
}

console.log('\n=== GET /egress（代理未运行时应 409）===')
{
  const res = mockRes()
  await routes.get('/dsh-local-proxy-own/egress')(mockReq('GET'), res)
  console.log(`  HTTP ${res.statusCode} → ${String(res.body).slice(0, 120)}`)
  check(res.statusCode === 409 || res.statusCode === 200, `状态码合理：${res.statusCode}`)
  if (res.statusCode === 200) {
    const d = JSON.parse(res.body)
    console.log(`  经代理 ${d.proxied?.ip} vs 直连 ${d.direct?.ip} differs=${d.differs}`)
    check(typeof d.differs === 'boolean', 'differs 字段存在（判断隧道是否真在承载）')
  }
}

console.log('\n=== POST /switch：只改 sysMode 不该动核心 ===')
{
  // 用一个会被拒绝的 sysMode（代理没跑）验证：不该因此重启核心
  const req = mockReq('POST')
  req.on = undefined
  // readJsonBody 需要流式读取；这里直接给它一个可读的 async iterator
  const bodyStr = JSON.stringify({ sysMode: 'off' })
  const readable = {
    method: 'POST',
    headers: { host: '127.0.0.1:1870', 'content-type': 'application/json', 'content-length': String(bodyStr.length) },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: (async function* () { yield Buffer.from(bodyStr) })(),
    // readBody 用的是 req.on('data') / req.on('end') 事件流，不是 async iterator。
    // 注册 data 时立刻投喂、注册 end 时稍后收口，顺序与真实 HTTP 请求一致。
    on(ev, cb) {
      if (ev === 'data') queueMicrotask(() => cb(Buffer.from(bodyStr)))
      else if (ev === 'end') setTimeout(() => cb(), 10)
      // error / aborted 不触发
    },
    destroy() {},
  }
  const res = mockRes()
  await routes.get('/dsh-local-proxy-own/switch')(readable, res)
  console.log(`  HTTP ${res.statusCode} → ${String(res.body).slice(0, 200)}`)
  check(res.statusCode === 200 || res.statusCode === 400, `状态码合理：${res.statusCode}`)
  const d = JSON.parse(res.body || '{}')
  check(typeof d.text === 'string' && d.text.length > 0, `回执有文案：${String(d.text).split('\n')[0].slice(0, 70)}`)
  check(d.status && typeof d.status.running === 'boolean', '回执附带了最新 status（面板一次往返即可刷新）')
}

console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} → ${fail === 0 ? 'PASS' : 'FAIL'} ===`)
process.exit(fail === 0 ? 0 : 1)
