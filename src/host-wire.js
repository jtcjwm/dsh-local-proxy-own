// host-wire.js —— 把「本机回环代理」装进 DSH 自己
//
// 为什么要这一层：DSH 桌面版的启动路径（dsh-app-boot）不调用
// @deepseek-ai/dsh-http-proxy 的 installProxyFromEnvironment()，只有 CLI 的
// runProfile() 调（实测 0.2.1-rc.2：profile-boot-C14i-8IN.js:256 调，dsh-app-boot
// 全包 0 处调用）。后果是 agent 自己的 web_fetch / 联网工具永远直连，而 shell 里
// 起的 curl/git 却会读环境变量 —— 同一个会话两套网络行为。本插件起了代理却管不到
// DSH 自身，这一层就是把这个断点接上。
//
// 机制与优先级沿用上游同名包 dsh-local-proxy-own@1.0.1（MIT, WoodSettler）的实测结论：
//   发现顺序 ① .env 里用户显式写的 > ② Windows 系统代理注册表 > ③ 进程继承的变量
//   （③ 只兜底：DSH 重启会继承上一代环境，让它优先就会形成「旧端口一代代传下去」
//     的单向陷阱，删 .env 都救不回来）
//   安装前必须 delete 掉继承来的代理变量：dsh-http-proxy 的
//   proxyEnvironmentForChild() 用 `inherited[name] !== undefined` 判断「用户设过」，
//   分不清「用户设的」和「上一代泄漏的」，会把继承值原样发给子进程。
//
// 硬约束：
//   - 只接受 http/https 协议 + 只接受回环地址（127.0.0.1 / localhost / ::1）；
//   - 任何一步失败只记日志、什么都不做，绝不让原本可用的直连失效；
//   - 宿主模块一律 dynamic import + try/catch：静态 import 在未来版本解析失败会
//     拖垮整个 profile（DSH 起不来），动态 import 只会留一行日志。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']
const PROXY_NAMES_LOWER = ['http_proxy', 'https_proxy', 'all_proxy']
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1'
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

let installed = null // { dispose, proxyUrl, source, report }

// --- 宿主模块解析 -----------------------------------------------------------
// 为什么不能只用 bare import：本插件住在 D:\DSH\plugins\，Node 从真实路径向上找不到
// 任何 node_modules（实测 ERR_MODULE_NOT_FOUND：D:/DSH/plugins、D:/DSH、D:/ 三级都无）。
// 上游包住在 profile 的 node_modules 里，同级就能解析，所以它只需要 bare import。
// 桌面版若以 --preserve-symlinks 经 junction 路径加载，bare import 会命中；经真实路径
// 加载则必然失败。两种都要能活：先试 bare，失败再按候选根目录读包的 main 直接 file-import。
function hostModuleRoots() {
  const roots = []
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p) }
  for (const p of String(process.env.DSH_PLUGIN_MODULE_ROOTS || '').split(path.delimiter)) push(p && p.trim())
  // 桌面版：execPath 就是安装根下的 exe，resources/app/{dsh/,}node_modules 是宿主自带包。
  const exeDir = path.dirname(process.execPath || '')
  if (exeDir) {
    push(path.join(exeDir, 'resources', 'app', 'dsh', 'node_modules'))
    push(path.join(exeDir, 'resources', 'app', 'node_modules'))
    push(path.join(exeDir, 'node_modules'))
  }
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  if (home) push(path.join(home, 'profiles', 'desktop', 'node_modules'))
  // 万一哪天被复制进 profile 依赖树里，同级 node_modules 也算。
  push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules'))
  push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'))
  return roots.filter((r) => { try { return fs.existsSync(r) } catch { return false } })
}

function mainFileOf(pkgDir) {
  try {
    const pj = path.join(pkgDir, 'package.json')
    if (!fs.existsSync(pj)) return null
    const meta = JSON.parse(fs.readFileSync(pj, 'utf8'))
    const candidates = []
    if (typeof meta.main === 'string' && meta.main) candidates.push(meta.main)
    const exp = meta.exports
    if (typeof exp === 'string') candidates.push(exp)
    else if (exp && typeof exp === 'object') {
      const dot = exp['.']
      if (typeof dot === 'string') candidates.push(dot)
      else if (dot && typeof dot === 'object') candidates.push(dot.import || dot.default || dot.require)
    }
    if (meta.module) candidates.push(meta.module)
    for (const c of candidates.filter(Boolean)) {
      const f = path.join(pkgDir, c)
      if (fs.existsSync(f)) return f
    }
    for (const f of ['lib/index.js', 'index.js', 'dist/index.js']) {
      if (fs.existsSync(path.join(pkgDir, f))) return path.join(pkgDir, f)
    }
    return null
  } catch { return null }
}

async function importHostModule(name, log) {
  try {
    return await import(name)
  } catch (bareError) {
    for (const root of hostModuleRoots()) {
      const file = mainFileOf(path.join(root, name))
      if (!file) continue
      try {
        const mod = await import(pathToFileURL(file).href)
        log(`解析：${name} 经文件路径命中 ${file}`)
        return mod
      } catch { /* 换下一个候选根 */ }
    }
    log(`解析：${name} bare import 失败且文件兜底也没命中（${bareError?.code ?? ''}）`)
    throw bareError
  }
}

/** 规范成可用代理地址；非 http(s) 或非回环一律 undefined。 */
export function normalizeProxyUrl(candidate) {
  const raw = String(candidate ?? '').trim()
  if (raw === '') return undefined
  const withScheme = raw.includes('://') ? raw : `http://${raw}`
  let url
  try { url = new URL(withScheme) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return undefined
  const auth = url.username === '' ? '' : `${url.username}${url.password === '' ? '' : `:${url.password}`}@`
  return `${url.protocol}//${auth}${url.host}`
}

/** ProxyServer 支持两种写法：`127.0.0.1:7899` 与 `http=…;https=…`。 */
function parseProxyServer(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return undefined
  if (!text.includes('=')) return normalizeProxyUrl(text)
  const byScheme = new Map()
  for (const part of text.split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    byScheme.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim())
  }
  return normalizeProxyUrl(byScheme.get('https') ?? byScheme.get('http'))
}

/** 读 Windows 用户系统代理（只有 ProxyEnable=1 且指向回环才算）。 */
async function readWindowsSystemProxy(log) {
  if (process.platform !== 'win32') return undefined
  const regExe = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\reg.exe`
  const query = async (name) => {
    try {
      const { stdout } = await execFileAsync(regExe, ['query', REG_KEY, '/v', name], { windowsHide: true })
      return stdout
    } catch {
      const { stdout } = await execFileAsync('reg', ['query', REG_KEY, '/v', name], { windowsHide: true })
      return stdout
    }
  }
  try {
    const enabled = await query('ProxyEnable')
    if (!/0x1\b/i.test(enabled)) { log('发现：系统代理未开启（ProxyEnable≠1）'); return undefined }
    const m = /ProxyServer\s+REG_SZ\s+(.+)/.exec(await query('ProxyServer'))
    const url = parseProxyServer(m?.[1])
    log(`发现：系统代理 ${url ?? '(无法解析)'}`)
    return url
  } catch (error) {
    log(`发现：读系统代理失败 ${error?.message ?? error}`)
    return undefined
  }
}

async function discover(log, preferUrl, ctx) {
  const preferred = normalizeProxyUrl(preferUrl)
  if (preferred) return { url: preferred, source: 'self:local_proxy_start' }

  let launchEnv = null
  try { launchEnv = await importHostModule('@deepseek-ai/dsh-launch-environment', log) } catch (e) {
    log(`发现：拿不到 dsh-launch-environment（${e?.message ?? e}），只看注册表`)
  }
  if (launchEnv) {
    // snapshot.getFrom 单独问 .env 层；不能用 get()，它按 SOURCE_ORDER 先返回 process 层。
    let snapshot = null
    try { snapshot = launchEnv.launchEnvironmentOf?.(ctx ?? {}) ?? null } catch { snapshot = null }
    for (const name of PROXY_NAMES) {
      let hit = null
      try { hit = snapshot?.getFrom?.(name, ['project-env', 'user-env']) ?? null } catch { hit = null }
      const url = normalizeProxyUrl(hit?.value)
      if (url !== undefined) return { url, source: `env-explicit:${name}` }
    }
  }

  const registry = await readWindowsSystemProxy(log)
  if (registry) return { url: registry, source: 'registry:ProxyServer' }

  for (const name of PROXY_NAMES) {
    const url = normalizeProxyUrl(process.env[name])
    if (url !== undefined) return { url, source: `env-inherited:${name}`, weak: true }
  }
  return {}
}

/** 装上；已装且同地址则幂等返回。永不抛错。 */
export async function wireHostProxy({ preferUrl, ctx, log = () => {}, report } = {}) {
  if (!installed) {
    const found = await discover(log, preferUrl, ctx)
    if (!found.url) { log('未找到可用的回环代理，保持直连（什么都没改）'); return { ok: false, action: 'none' } }
    let launchEnv, httpProxy
    try {
      launchEnv = await importHostModule('@deepseek-ai/dsh-launch-environment', log)
      httpProxy = await importHostModule('@deepseek-ai/dsh-http-proxy', log)
    } catch (error) {
      log(`拿不到宿主代理模块，保持直连：${error?.message ?? error}`)
      return { ok: false, action: 'no-module', error: String(error?.message ?? error) }
    }
    try {
      const noProxy = process.env.NO_PROXY || DEFAULT_NO_PROXY
      const snapshot = launchEnv.createLaunchEnvironmentSnapshot([{
        source: 'process',
        values: { HTTP_PROXY: found.url, HTTPS_PROXY: found.url, ALL_PROXY: found.url, NO_PROXY: noProxy },
      }])
      // 先清继承值，再装策略（见文件头 SC-0022 说明）。
      for (const name of [...PROXY_NAMES, ...PROXY_NAMES_LOWER]) delete process.env[name]
      const dispose = await httpProxy.installProxyFromEnvironment(snapshot, (message) => {
        const line = `dispatcher: ${message}`
        log(line)
        if (report) report(line)
      })
      let route = null
      try {
        route = httpProxy.proxyRouteFor(new URL('https://www.google.com/robots.txt'))?.proxied ?? null
      } catch (e) { log(`自检跳过：proxyRouteFor ${e?.message ?? e}`) }
      installed = { dispose, proxyUrl: found.url, source: found.source, noProxy }
      log(`已把 DSH 自身接上 ${found.url}（来源 ${found.source}，no_proxy=${noProxy}，google 走代理=${route}）`)
      return { ok: true, action: 'installed', proxyUrl: found.url, source: found.source, proxiedSelfCheck: route, noProxy }
    } catch (error) {
      log(`装失败，维持直连：${error?.message ?? error}`)
      return { ok: false, action: 'error', error: String(error?.message ?? error) }
    }
  }
  if (preferUrl && normalizeProxyUrl(preferUrl) !== installed.proxyUrl) {
    log(`已装 ${installed.proxyUrl}，忽略新候选 ${preferUrl}（先 unwire 再装）`)
    return { ok: true, action: 'unchanged-but-differs', proxyUrl: installed.proxyUrl, wanted: preferUrl }
  }
  return { ok: true, action: 'already', proxyUrl: installed.proxyUrl, source: installed.source }
}

/** 卸下；没装过也返回成功（幂等，关停路径可以直接调）。 */
export async function unwireHostProxy({ log = () => {} } = {}) {
  if (!installed) { log('本来就没装 DSH 代理策略，无需卸下'); return { ok: true, action: 'none' } }
  const cur = installed
  installed = null
  try { await cur.dispose?.(); log(`已卸下 DSH 代理策略（原 ${cur.proxyUrl}）`) }
  catch (error) { log(`卸下时报错（状态已清，可能残留进程内策略直到重启）：${error?.message ?? error}`) }
  return { ok: true, action: 'disposed', proxyUrl: cur.proxyUrl }
}

export function hostWiredState() {
  return installed ? { wired: true, proxyUrl: installed.proxyUrl, source: installed.source, noProxy: installed.noProxy } : { wired: false }
}
