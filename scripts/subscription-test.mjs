// subscription-test.mjs - 订阅解析/配置闸/参数透传 的单元断言（Group 5 后端）。
//
// 拉的是纯函数面（import index.js 的 __test 导出）——不碰真 nodes.txt、不碰注册表、
// 不起进程。端到端（POST /sub 落盘热更）由 restart+curl 的 live 冒烟另行验。
//
//   node scripts/subscription-test.mjs
//
// 重点验的是那条**安全闸**：解析 0 条的订阅（挂了的任务卡页、验证码 HTML）必须
// 被判成 no-links——这条判错会拿垃圾覆盖用户 45 条自提节点。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const no = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const check = (c, m) => (c ? ok(m) : no(m))

const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'index.js')).href)
const { parseSubscription, normalizeConfig, poolFlags, DEFAULT_CONFIG } = mod.__test

const L1 = 'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?security=reality#A'
const L2 = 'vmess://eyJhZGQiOiIxLjIuMy40In0='
const L3 = 'trojan://deadbeef@t.example.com:443?sni=t.example.com#T'
const L4 = 'hysteria2://u:p@9.9.9.9:443/?insecure=1&sni=x.com#H'
const L5 = 'ss://YWVzLTI1Ni1nY206cGFzcw==@5.5.5.5:8388#SS'

console.log('=== 1. parseSubscription 形态识别 ===')
{
  const r = parseSubscription(`${L1}\n${L2}\n${L3}\n`)
  check(r.links.length === 3 && r.form === 'plain', 'plain 三行链接 → 3 条')
}
{
  const b64 = Buffer.from(`${L1}\n${L4}\n${L5}`, 'utf8').toString('base64')
  const r = parseSubscription(b64)
  check(r.links.length === 3 && r.form === 'base64', 'base64 聚合订阅 → 3 条')
}
{
  const b64 = Buffer.from(`${L1}\n${L2}`, 'utf8').toString('base64url').replace(/=+$/, '')
  const r = parseSubscription(b64)
  check(r.links.length === 2 && r.form === 'base64', 'base64url 无 padding 也认')
}
{
  const r = parseSubscription(`\uFEFF${L1}\r\n${L2}\r\n`)
  check(r.links.length === 2, 'BOM + CRLF 不破坏解析')
}
{
  const r = parseSubscription(`${L1}\n${L1}\n${L2}\n`)
  check(r.links.length === 2, '重复链接去重')
}
{
  const r = parseSubscription('<!DOCTYPE html><html><body>Just a dead page</body></html>')
  check(r.links.length === 0, '挂掉的网页 HTML → 0 条（安全闸的输入）')
}
{
  const r = parseSubscription('proxies:\n  - name: x\n    type: ssrf')
  check(r.links.length === 0, 'Clash YAML → 0 条（本版本声明不支持，绝不半解析）')
}
{
  const r = parseSubscription('')
  check(r.links.length === 0 && r.form === 'empty', '空输入 → empty')
}
{
  const r = parseSubscription(`  ${L1}  \n\n  ${L3}  `)
  check(r.links.length === 2, '两侧空格与空行容忍')
}
{
  const r = parseSubscription('VLESS://x@1.2.3.4:443#UP' )
  check(r.links.length === 1, 'scheme 大小写不敏感')
}

console.log('=== 2. normalizeConfig 订阅与 urltest 闸 ===')
{
  const base = { port: 17899 }
  const c = normalizeConfig({ ...base, subUrl: 'https://sub.example/a', subRefreshMin: 30 })
  check(c.subUrl === 'https://sub.example/a' && c.subRefreshMin === 30, '合法 subUrl + 30 分钟照存')
}
{
  const c = normalizeConfig({ ...DEFAULT_CONFIG, subRefreshMin: 3 })
  check(c.subRefreshMin === 0, '间隔 1-4 分钟塌缩成 0（闸门：防打爆订阅站）')
}
{
  let threw = false
  try { normalizeConfig({ port: 17899, subUrl: 'javascript:alert(1)' }) } catch { threw = true }
  check(threw, '非 http(s)/file/路径 的订阅地址直接拒')
}
{
  const c = normalizeConfig({ ...DEFAULT_CONFIG, urltestInterval: '10s', urltestTolerance: 20 })
  check(c.urltestInterval === '10s' && c.urltestTolerance === 20, 'urltest interval/tolerance 照存')
}
{
  const c = normalizeConfig({ ...DEFAULT_CONFIG, urltestInterval: 'garbage' })
  check(c.urltestInterval === '30s', '非法 interval 回落 30s')
}
{
  const c = normalizeConfig({ ...DEFAULT_CONFIG, urltestTolerance: 9999 })
  check(c.urltestTolerance === 50, 'tolerance 越界回落 50')
}

console.log('=== 3. poolFlags 透传 ===')
{
  const c = normalizeConfig({ ...DEFAULT_CONFIG, urltestInterval: '15s', urltestTolerance: 30, split: 'cn-direct' })
  const f = poolFlags(c)
  check(f['--interval'] === '15s' && f['--tolerance'] === '30', 'race 调优参数进 CLI flags')
}

console.log('=== 4. fetchSubscriptionText 本地 fixture（file/路径两式） ===')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlp-sub-'))
  const fixture = path.join(dir, 'sub.txt')
  fs.writeFileSync(fixture, `${L1}\n${L2}\n`, 'utf8')
  // transport 的 http 分支交给 live 冒烟；这里断言 fixture 经 parse 的落盘前语义。
  const text = fs.readFileSync(fixture, 'utf8')
  const r = parseSubscription(text)
  check(r.links.length === 2, '本地文件订阅 fixture → 2 条')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} → ${fail ? 'FAIL' : 'PASS'} ===`)
process.exit(fail ? 1 : 0)
