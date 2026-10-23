// tool-schema-check.mjs - structural check of every tool the plugin registers,
// run under the HOST's own node runtime (not the dev node on PATH).
//
//   "<primary-runtime>\dependencies\node\bin\node.exe" scripts/tool-schema-check.mjs
//
// Why this exists next to headless-test.mjs: the harness fakes ctx, so it cannot
// tell you whether the host's runtime can even import the module. This one runs
// apply() under the real runtime and validates the tool definitions themselves.
//
// Note on schemastery: calling Schema.from() on a plain JSON-Schema object here
// reports "cannot infer schema from [object Object]" for every tool, including
// the four that predate the node pool. That is this script misusing the API, not
// a defect in the tools - so the check below is structural instead.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')

const tools = new Map()
const routes = []
const ctx = {
  logger: {
    info: () => {},
    warn: (...a) => console.log('[warn]', ...a),
    error: (...a) => console.log('[error]', ...a),
  },
  get(key) {
    if (key === 'tools') return { register: (d) => { tools.set(d.name, d); return () => tools.delete(d.name) } }
    if (key === 'webServer') return { register: (r) => { routes.push(r.path); return () => {} } }
    return undefined
  },
  inject(keys, fn) { if (keys.includes('webServer')) fn(ctx); return () => {} },
  effect(fn) { try { return fn() } catch {} },
  on() {},
}

console.log(`node ${process.version} (${process.execPath})`)
const mod = await import(pathToFileURL(path.join(PKG, 'src', 'index.js')).href)
console.log('模块导出:', Object.keys(mod).join(','))

let bad = 0
if (!Array.isArray(mod.inject) || !mod.inject.includes('tools') || !mod.inject.includes('webServer')) {
  bad++
  console.log(`  ✗ inject 导出缺失或不含 tools/webServer（宿主会加载模块却不启动插件）: ${JSON.stringify(mod.inject)}`)
} else {
  console.log(`  ✓ inject = ${JSON.stringify(mod.inject)}`)
}

try {
  mod.apply(ctx)
  console.log('  ✓ apply() 未抛异常')
} catch (e) {
  bad++
  console.log('  ✗ apply() 抛异常 =>', (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e))
}
console.log(`  工具 ${tools.size} 个，路由 ${routes.length} 条: ${routes.join(' ')}`)
// 第 4 组起面板多了 /nodes /egress /switch 三条；Group 5/6 再加 /sub /reprobe。
// 期望清单要写全名——只数条数会把「多一条又少一条」放过去。
const EXPECTED_ROUTES = [
  '/dsh-local-proxy-own/status',
  '/dsh-local-proxy-own/start',
  '/dsh-local-proxy-own/stop',
  '/dsh-local-proxy-own/selftest',
  '/dsh-local-proxy-own/nodes',
  '/dsh-local-proxy-own/egress',
  '/dsh-local-proxy-own/switch',
  '/dsh-local-proxy-own/sub',
  '/dsh-local-proxy-own/reprobe',
]
for (const r of EXPECTED_ROUTES) {
  if (!routes.includes(r)) { bad++; console.log(`  ✗ 缺路由 ${r}`) }
}
if (routes.length !== EXPECTED_ROUTES.length) {
  bad++
  console.log(`  ✗ 路由数应为 ${EXPECTED_ROUTES.length}，实际 ${routes.length}`)
}

const isSchemaObject = (s) => s && typeof s === 'object' && s.type === 'object'

for (const [name, def] of tools) {
  const problems = []
  if (!def.description || def.description.length < 20) problems.push('description 过短')
  if (typeof def.execute !== 'function') problems.push('缺 execute')
  const p = def.parameters
  if (!isSchemaObject(p)) problems.push('parameters 不是 type:object 的 JSON Schema')
  else {
    if (p.additionalProperties !== false) problems.push('parameters 未声明 additionalProperties:false')
    const props = p.properties || {}
    // An empty properties map is correct for a tool that takes no arguments
    // (local_proxy_status / local_proxy_stop) - only flag a missing map.
    if (!('properties' in p)) problems.push('parameters 缺 properties')
    for (const r of p.required || []) {
      if (!(r in props)) problems.push(`required 里的 ${r} 不在 properties 中`)
    }
    for (const [k, v] of Object.entries(props)) {
      if (!v || typeof v !== 'object' || !v.type) problems.push(`参数 ${k} 缺 type`)
      if (v.enum && !Array.isArray(v.enum)) problems.push(`参数 ${k} 的 enum 不是数组`)
    }
  }
  const out = def.output && (def.output.schema || def.output)
  if (out && !isSchemaObject(out)) problems.push('output.schema 不是 type:object')
  if (def.output && typeof def.output.render !== 'function') problems.push('output 缺 render')

  if (problems.length) { bad++; console.log(`  ✗ ${name}: ${problems.join(' | ')}`) }
  else console.log(`  ✓ ${name}（${Object.keys(def.parameters.properties || {}).length} 个参数）`)
}

console.log(bad ? `\n结果：${bad} 项不通过` : '\n结果：全部通过')
process.exit(bad ? 1 : 0)
