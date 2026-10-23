// dsh-local-proxy-own - host half.
//
// Responsibilities:
//   1. spawn / stop the loopback proxy process (bin/proxy.js), single instance,
//      idempotent: a second start is a no-op, a stop on a free port still
//      succeeds;
//   2. optionally flip the Windows *user* system proxy (HKCU Internet Settings)
//      when - and only when - the operator asks for it, after writing an exact
//      value snapshot; stop restores every touched value, and a value that was
//      absent before start is deleted again (not blanked);
//   3. expose four agent tools (local_proxy_status / start / stop / selftest)
//      and the loopback HTTP routes the browser card uses.
//
// Nothing here installs a driver, creates a TUN adapter, writes a root
// certificate or terminates TLS: the proxy is an application-layer funnel.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { wireHostProxy, unwireHostProxy, hostWiredState } from './host-wire.js'

export const name = 'dsh-local-proxy-own'

// cordis only starts a plugin once every service listed here exists, and only
// then are they reachable through ctx. Without this export the host still
// loads the module, but apply() runs before `tools`/`webServer` are up: the
// defensive `ctx.get('tools') || ctx.tools` in registerTools() silently returns
// and registerRoutes() falls into the ctx.inject() branch that never fires.
// Net effect is a plugin that loads without error yet exposes no tools and no
// /dsh-local-proxy-own/* routes. Every working bundle in this profile declares it
// (dsh-meme: tools+webServer+..., dsh-dream-skin: webServer+webRuntime).
export const inject = ['tools', 'webServer']

const execFileAsync = promisify(execFile)

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(SRC_DIR, '..')
const PROXY_JS = path.join(PLUGIN_ROOT, 'bin', 'proxy.js')
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config.json')
const RUNTIME_DIR = path.join(PLUGIN_ROOT, '.runtime')
const STATE_PATH = path.join(RUNTIME_DIR, 'state.json')
const SNAPSHOT_PATH = path.join(RUNTIME_DIR, 'registry-snapshot.json')

const ROUTE_PREFIX = '/dsh-local-proxy-own'
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const TOUCHED_VALUES = ['ProxyEnable', 'ProxyServer', 'AutoConfigURL', 'AutoDetect']

const DEFAULT_PORT = 7899
const DEFAULT_LOG_DIR =
  process.env.LOCAL_PROXY_LOG_DIR || 'D:\\DSH\\dsh-搜索\\flywheel-re\\plugin-logs'
// Ports DSH itself uses on this host; starting the proxy there would fight the
// host, so they are refused with an explicit message instead of a bind race.
const RESERVED_PORTS = new Set([13382, 19388])

const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  upstream: '',
  systemProxy: false,
  // wireDsh = 起代理后顺手把 DSH 自己的联网请求也接上这个代理（进程内 dispatcher +
  // 子进程环境变量）。默认关：它改的是宿主进程行为，不是注册表，关停时会自动卸下。
  wireDsh: false,
  logDir: DEFAULT_LOG_DIR,
  // Node-pool settings. `nodes` empty means <plugin>/nodes.txt.
  nodes: '',
  // race = every live node in one sing-box urltest group (core fails over in
  // well under a second, no restart); single = one named node.
  mode: 'race',
  // cn-direct = domestic + LAN traffic stays direct, foreign goes through the
  // tunnel; all = everything through the tunnel; direct = tunnel unused.
  split: 'cn-direct',
  top: 0,
  reprobeMin: 0,
  // Remote subscription. subUrl empty = manual nodes.txt only. subRefreshMin
  // 0 = no auto refresh; >= 5 = host-side timer re-fetches and overwrites
  // nodes.txt ONLY when the fetch parses at least one link (a collapsed
  // subscription page never clobbers a good pool).
  subUrl: '',
  subRefreshMin: 0,
  // urltest tuning (race mode): how often the core re-tests, and the ms band
  // a challenger must beat the incumbent by before switching (anti-flap).
  // Defaults match the measured daily-driver config.
  urltestInterval: '30s',
  urltestTolerance: 50,
  // Whether DSH starting up also brings the stack up. Default off - the user's
  // rule is 「找我要求开就开，不要求开一般就不开」 (2026-10-21 23:56). Closing DSH
  // always means a full teardown (teardownOnHostExit); that half is not optional.
  autoStart: false,
}

// In-memory view of the running child. Persisted metadata lives in state.json
// so a host restart can still find (and stop) a leftover process.
let runtime = null
// apply 尾部清扫（sweepSurvivors）是异步的，这个 promise 让 startProxy 串行等它
// 收尾——见 sweepSurvivors 与 startProxy 里的闸门注释，不加会「清扫杀新起进程」。
let reconcileInFlight = null
let exitHookInstalled = false

// --- config ------------------------------------------------------------------

const SPLIT_MODES = ['cn-direct', 'all', 'direct']
// The user says 直连 / 规则 / 全局; the config keys are direct / cn-direct / all.
// The alias table translates human wording into config keys so nobody has to
// remember the English enum, and an unknown word returns null instead of
// silently falling back to a mode the user did not ask for.
const SPLIT_ALIAS = {
  '直连': 'direct', '直連': 'direct', direct: 'direct', off: 'direct', none: 'direct',
  '规则': 'cn-direct', '規則': 'cn-direct', '国内直连': 'cn-direct', '国内直連': 'cn-direct',
  'cn-direct': 'cn-direct', rule: 'cn-direct', rules: 'cn-direct', smart: 'cn-direct',
  '全局': 'all', global: 'all', all: 'all', '全走隧道': 'all',
}
function normalizeSplit(value) {
  const s = String(value ?? '').trim()
  if (!s) return null
  const hit = SPLIT_ALIAS[s] || SPLIT_ALIAS[s.toLowerCase()]
  if (SPLIT_MODES.includes(hit)) return hit
  return SPLIT_MODES.includes(s) ? s : null
}
/** 给人看的中文对照，status 与工具回执都用它。 */
function splitLabel(mode) {
  return { direct: '直连（全不走隧道）', 'cn-direct': '规则（国内直连、国外走隧道）', all: '全局（全走隧道）' }[mode] || mode
}
const POOL_MODES = ['race', 'single']

function normalizeConfig(input) {
  const config = { ...DEFAULT_CONFIG, ...(input && typeof input === 'object' ? input : {}) }
  const port = Number(config.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`端口必须是 1024-65535 之间的整数，收到 ${config.port}`)
  }
  if (RESERVED_PORTS.has(port)) {
    throw new Error(`端口 ${port} 被 DSH 占用，换一个（默认 ${DEFAULT_PORT}）`)
  }
  const upstream = typeof config.upstream === 'string' ? config.upstream.trim() : ''
  if (upstream && !/^(socks5h?|http):\/\//i.test(upstream) && !/^[^/\s]+:\d+$/.test(upstream)) {
    throw new Error('上游只接受 socks5:// 、socks5h:// 、http:// 或空（直连）')
  }
  const split = SPLIT_MODES.includes(config.split) ? config.split : DEFAULT_CONFIG.split
  const mode = POOL_MODES.includes(config.mode) ? config.mode : DEFAULT_CONFIG.mode
  const top = Number(config.top)
  const reprobeMin = Number(config.reprobeMin)
  const subUrl = typeof config.subUrl === 'string' ? config.subUrl.trim() : ''
  if (subUrl && !/^(https?:\/\/|file:\/\/|[a-zA-Z]:[\\/]|[./\\])/i.test(subUrl)) {
    throw new Error('订阅地址只接受 http(s)://、file:// 或本地路径')
  }
  const subRefreshMin = Number(config.subRefreshMin)
  return {
    port,
    upstream,
    systemProxy: config.systemProxy === true,
    wireDsh: config.wireDsh === true,
    logDir: typeof config.logDir === 'string' && config.logDir ? config.logDir : DEFAULT_LOG_DIR,
    nodes: typeof config.nodes === 'string' ? config.nodes.trim() : '',
    mode,
    split,
    top: Number.isInteger(top) && top > 0 ? top : 0,
    reprobeMin: Number.isInteger(reprobeMin) && reprobeMin > 0 ? reprobeMin : 0,
    subUrl,
    subRefreshMin: Number.isInteger(subRefreshMin) && subRefreshMin >= 5 ? subRefreshMin : 0,
    urltestInterval: /^\d{1,4}(s|m)$/.test(String(config.urltestInterval || '')) ? String(config.urltestInterval) : '30s',
    urltestTolerance: Number.isInteger(Number(config.urltestTolerance)) && Number(config.urltestTolerance) >= 0 && Number(config.urltestTolerance) <= 600 ? Number(config.urltestTolerance) : 50,
    autoStart: config.autoStart === true,
  }
}

function loadConfig() {
  try {
    // Strip a BOM: Notepad and PowerShell 5.1's `-Encoding UTF8` both add one,
    // and JSON.parse() chokes on it — which would silently fall back to
    // defaults and make the user's saved settings look ignored.
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')
    return normalizeConfig(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function saveConfig(config) {
  try {
    fs.mkdirSync(PLUGIN_ROOT, { recursive: true })
    const tmp = `${CONFIG_PATH}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, CONFIG_PATH)
  } catch {
    // settings are best-effort: a read-only install must not break start
  }
}

// --- Remote subscription (Group 5) ------------------------------------------
// nodes.txt stays the pool's single source of truth; a subscription is just
// another writer into it. Three independently testable layers:
//   parseSubscription(text)   pure: plain link lines OR base64 blob -> [links]
//   fetchSubscriptionText(u)  transport: http(s) via curl with --noproxy '*'
//                             (fetching a subscription through our own proxy
//                             would be a bootstrap deadlock when the pool is
//                             what we're replacing), file:// and local paths
//   applySubscription(u)      persistence: dated backup, atomic write, then
//                             hot update through the EXISTING paths only
//                             (watcher mtime / explicit CLI reload / offline).
// One safety rail shared by manual and timer: zero parsed links NEVER touches
// the node file - a collapsed subscription page must not clobber a good pool.
const SUB_SCHEMES = /^(vmess|vless|trojan|ss|hysteria2?|tuic|anytls):\/\//i

function parseSubscription(text) {
  const raw = String(text || '').replace(/^/, '').trim()
  if (!raw) return { links: [], form: 'empty' }
  const tryLines = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => SUB_SCHEMES.test(l))
  let links = tryLines(raw)
  let form = 'plain'
  if (!links.length) {
    const b64 = raw.replace(/\s+/g, '')
    if (/^[A-Za-z0-9+/=_-]+$/.test(b64) && b64.length > 16) {
      try {
        const dec = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
        links = tryLines(dec)
        form = 'base64'
      } catch {
        links = []
      }
    }
  }
  // Dedup by the full link: subscriptions repeat entries across refreshes.
  links = [...new Set(links)]
  return { links, form }
}

async function fetchSubscriptionText(urlOrPath) {
  const u = String(urlOrPath || '').trim()
  if (!u) throw new Error('没有订阅地址')
  if (/^https?:\/\//i.test(u)) {
    // --proto pins the scheme whitelist: no redirect can walk curl into
    // file:// or gopher:// even if the subscription host turns hostile.
    const { stdout } = await execFileAsync('curl.exe', [
      '-sS', '-L', '--proto', '=http,https', '--noproxy', '*', '--max-time', '20',
      '-A', 'dsh-local-proxy-own/1.0 subscription', u,
    ], { windowsHide: true, timeout: 25000, maxBuffer: 16 * 1024 * 1024 })
    return String(stdout || '')
  }
  if (/^file:\/\//i.test(u)) return fs.readFileSync(new URL(u), 'utf8')
  if (/^[a-zA-Z]:[\\/]|^[./\\]/.test(u)) return fs.readFileSync(u, 'utf8')
  throw new Error('订阅地址只支持 http(s)://、file:// 或本地路径')
}

function nodesFilePath(config) {
  return config.nodes ? config.nodes : path.join(PLUGIN_ROOT, 'nodes.txt')
}

let lastSubFetch = null

async function applySubscription(urlOrPath, options = {}) {
  const text = await fetchSubscriptionText(urlOrPath)
  const { links, form } = parseSubscription(text)
  if (!links.length) return { ok: false, code: 'no-links', form, total: 0 }
  if (options.preview) return { ok: true, preview: true, count: links.length, form, sample: links.slice(0, 3) }
  const config = loadConfig()
  const file = nodesFilePath(config)
  let prev = null
  try {
    if (fs.existsSync(file)) {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      prev = `${file}.${stamp}.prev.txt`
      fs.copyFileSync(file, prev)
    }
  } catch {
    prev = null
  }
  const tmp = `${file}.sub.tmp`
  fs.writeFileSync(tmp, `${links.join('\n')}\n`, 'utf8')
  fs.renameSync(tmp, file)
  // Hot-reload routing: watcher alive => its mtime poll reloads the core on
  // its own, do nothing. Watcher off but core up => explicit CLI reload.
  // Core down => disk only; the next start reads the new file anyway.
  let reload = 'disk-only'
  try {
    let watchPid = 0
    try {
      watchPid = Number(fs.readFileSync(path.join(RUNTIME_DIR, 'watch.pid'), 'utf8').trim()) || 0
    } catch {}
    if (watchPid && processAlive(watchPid)) {
      reload = 'watcher'
    } else {
      let coreState = null
      try {
        coreState = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'singbox-state.json'), 'utf8'))
      } catch {}
      if (coreState?.pid && processAlive(coreState.pid)) {
        await runSingboxNode('reload', null, { port: coreState.port || SINGBOX_PORT, flags: poolFlags(config) })
        reload = 'reload'
      }
    }
  } catch {
    reload = 'written-reload-pending'
  }
  lastSubFetch = { at: Date.now(), count: links.length, form, from: String(urlOrPath), file, prev, reload, auto: options.auto === true }
  return { ok: true, count: links.length, form, file, prev, reload }
}

// Timer lives host-side (NOT in the watcher): the node file must be fresh for
// the next start even when the whole stack is off. 0 / 1-4 minutes collapse to
// "off" in normalizeConfig; syncSubTimer re-arms after every config write.
let subTimer = null
let subBusy = false

function syncSubTimer() {
  const config = loadConfig()
  const want = config.subUrl && config.subRefreshMin >= 5 ? config.subRefreshMin * 60000 : 0
  if (!want) {
    if (subTimer) {
      clearInterval(subTimer)
      subTimer = null
    }
    return
  }
  if (subTimer && subTimer.every === want) return
  if (subTimer) clearInterval(subTimer)
  subTimer = setInterval(() => {
    const c = loadConfig()
    if (!c.subUrl || subBusy) return
    subBusy = true
    applySubscription(c.subUrl, { auto: true })
      .catch(() => {})
      .finally(() => {
        subBusy = false
      })
  }, want)
}

// --- Background re-probe for the panel button -------------------------------
// A full pool probe dials every node for real (~133 s measured on 45 nodes at
// concurrency 2) - no sane HTTP request may block that long, so the button
// spawns the SAME CLI the tools use, detached. A marker file prevents double
// launches and lets the panel show a live "probing" state.
const REPROBE_MARK = path.join(RUNTIME_DIR, 'reprobe.json')

function startBackgroundReprobe() {
  try {
    const m = JSON.parse(fs.readFileSync(REPROBE_MARK, 'utf8'))
    if (m?.pid && processAlive(m.pid) && Date.now() - Number(m.at || 0) < 20 * 60000) {
      return { started: false, running: true, sinceMin: Math.max(0, Math.round((Date.now() - Number(m.at || 0)) / 60000)) }
    }
  } catch {}
  const nodePath = resolveRuntimeNode()
  if (!nodePath) throw new Error('找不到可用的 node 运行时')
  const config = loadConfig()
  const argv = [SINGBOX_JS, 'probe']
  for (const [k, v] of Object.entries(poolFlags(config))) argv.push(k, String(v))
  const child = spawn(nodePath, argv, {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(REPROBE_MARK, `${JSON.stringify({ pid: child.pid, at: Date.now() })}\n`, 'utf8')
  } catch {}
  return { started: true, running: true, pid: child.pid, etaSec: 150 }
}

function reprobeState() {
  try {
    const m = JSON.parse(fs.readFileSync(REPROBE_MARK, 'utf8'))
    if (m?.pid && processAlive(m.pid) && Date.now() - Number(m.at || 0) < 20 * 60000) {
      return { running: true, sinceMin: Math.max(0, Math.round((Date.now() - Number(m.at || 0)) / 60000)) }
    }
  } catch {}
  return { running: false }
}

function readStateFile() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    if (!state || typeof state !== 'object') return null
    if (!Number.isInteger(Number(state.port)) || !Number.isInteger(Number(state.pid))) return null
    return { ...state, port: Number(state.port), pid: Number(state.pid) }
  } catch {
    return null
  }
}

function writeStateFile(state) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // state file is an aid for the next host boot, never a hard dependency
  }
}

// Derived artifacts that outlive a stop on purpose. probe.json is the latency
// ranking cache that `start`/`switch` consume - throwing it away forces a full
// ~70s re-probe of the pool on the next start; proxy.pac is regenerable but
// cheap to keep so a browser pointing at its file:/// URL keeps working.
// This mirrors bin/singbox-node.js cleanup(), which keeps the same two.
const RUNTIME_KEEP = new Set(['probe.json', 'proxy.pac'])

// The core (sing-box) and its file watcher are detached processes: they outlive
// the host, and these files are the only credentials that let a later `stop`
// find them. Measured 2026-10-21 22:35 - the host restarted, its child proxy.js
// died with it, the exit handler below wiped the whole directory, and the core
// kept listening on 18999 with no pid file left. Result: status reported
// orphan=false, `stop` found nothing to kill, and the next `start` collided on
// the port. So a proxy-only cleanup must never touch these.
const CORE_KEEP = new Set(['singbox.pid', 'watch.pid', 'singbox-state.json', 'sing-box.json', 'sing-box.log'])

function clearRuntimeFiles(options = {}) {
  // The registry snapshot survives unless the caller proves the registry was
  // restored: a child that dies while the system proxy is pointed at it must
  // leave the snapshot behind for stop / next-boot reconcile.
  const keepSnapshot = options.dropSnapshot !== true
  const keepAll = new Set([
    ...(options.keepDerived === false ? [] : RUNTIME_KEEP),
    // scope:'proxy' = only the proxy itself went away; the core is still ours.
    ...(options.scope === 'proxy' ? CORE_KEEP : []),
  ])
  try {
    const entries = fs.readdirSync(RUNTIME_DIR)
    for (const entry of entries) {
      if (keepSnapshot && entry === path.basename(SNAPSHOT_PATH)) continue
      if (keepAll.has(entry)) continue
      try {
        fs.rmSync(path.join(RUNTIME_DIR, entry), { force: true, recursive: true })
      } catch {}
    }
  } catch {}
  try {
    if (fs.readdirSync(RUNTIME_DIR).length === 0) fs.rmdirSync(RUNTIME_DIR)
  } catch {}
}

// --- registry ----------------------------------------------------------------

async function regQueryAll() {
  try {
    const { stdout } = await execFileAsync('reg', ['query', REG_KEY], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    return parseRegOutput(stdout)
  } catch (error) {
    if (error && (error.code === 1 || /unable to find/i.test(String(error.stderr || '')))) return {}
    throw error
  }
}

function parseRegOutput(stdout) {
  const values = {}
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || /^HKEY_/i.test(line.trim())) continue
    const parts = line.trim().split(/\s{2,}/)
    if (parts.length < 2) continue
    const [valueName, type] = parts
    if (!/^REG_/.test(type)) continue
    values[valueName] = { type, data: parts.length > 2 ? parts.slice(2).join('  ') : '' }
  }
  return values
}

async function regSet(valueName, type, data) {
  await execFileAsync('reg', ['add', REG_KEY, '/v', valueName, '/t', type, '/d', String(data), '/f'], {
    windowsHide: true,
  })
}

async function regDelete(valueName) {
  try {
    await execFileAsync('reg', ['delete', REG_KEY, '/v', valueName, '/f'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function takeSnapshot() {
  const values = await regQueryAll()
  const snapshot = { capturedAt: new Date().toISOString(), key: REG_KEY, values: {} }
  for (const valueName of [...TOUCHED_VALUES, 'ProxyOverride']) {
    const found = values[valueName]
    snapshot.values[valueName] =
      found === undefined
        ? { exists: false }
        : { exists: true, type: found.type, data: found.data }
  }
  return snapshot
}

function writeSnapshot(snapshot) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  const tmp = `${SNAPSHOT_PATH}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, SNAPSHOT_PATH)
}

function readSnapshot() {
  try {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.values !== 'object') return null
    return snapshot
  } catch {
    return null
  }
}

async function applySystemProxy(port) {
  const snapshot = await takeSnapshot()
  writeSnapshot(snapshot)
  // A PAC script would win over ProxyServer, so an existing one is removed
  // during the session and restored from the snapshot afterwards.
  if (snapshot.values.AutoConfigURL && snapshot.values.AutoConfigURL.exists) await regDelete('AutoConfigURL')
  if (snapshot.values.AutoDetect && snapshot.values.AutoDetect.exists) await regDelete('AutoDetect')
  await regSet('ProxyServer', 'REG_SZ', `127.0.0.1:${port}`)
  await regSet('ProxyEnable', 'REG_DWORD', '1')

  const after = await regQueryAll()
  const enable = after.ProxyEnable ? String(after.ProxyEnable.data).toLowerCase() : ''
  return {
    applied: enable === '0x1' || enable === '1',
    ProxyEnable: after.ProxyEnable ? after.ProxyEnable.data : '(absent)',
    ProxyServer: after.ProxyServer ? after.ProxyServer.data : '(absent)',
    snapshotPath: SNAPSHOT_PATH,
  }
}

// Restore is snapshot-driven: a value that did not exist before start is
// deleted, never rewritten as an empty string.
async function restoreSystemProxy() {
  const snapshot = readSnapshot()
  const report = { method: snapshot ? 'snapshot' : 'baseline-fallback', restored: [], deleted: [], errors: [] }

  if (!snapshot) {
    // No snapshot (first start crashed before writing, or the file was
    // removed): fall back to the documented machine baseline.
    await regSet('ProxyEnable', 'REG_DWORD', '0')
    report.restored.push('ProxyEnable=0')
    for (const valueName of ['ProxyServer', 'AutoConfigURL', 'AutoDetect']) {
      if (await regDelete(valueName)) report.deleted.push(valueName)
    }
  } else {
    for (const valueName of TOUCHED_VALUES) {
      const original = snapshot.values[valueName]
      try {
        if (!original || original.exists !== true) {
          if (await regDelete(valueName)) report.deleted.push(valueName)
        } else {
          await regSet(valueName, original.type, original.data)
          report.restored.push(`${valueName}=${original.data}`)
        }
      } catch (error) {
        report.errors.push(`${valueName}: ${error.message}`)
      }
    }
  }

  const after = await regQueryAll()
  const verification = verifyRegistry(after, snapshot)
  report.verification = verification
  report.ok = verification.ok
  if (verification.ok) {
    try {
      fs.rmSync(SNAPSHOT_PATH, { force: true })
    } catch {}
  }
  return report
}

// --- PAC generation (reusable) ------------------------------------------------

// bin/pac.js writes the file and prints one JSON line. Wrapped so the pac tool,
// the sysproxy tool and the guard all produce byte-identical artifacts.
async function generatePac(options = {}) {
  const config = loadConfig()
  const nodePath = resolveRuntimeNode()
  if (!nodePath) return { ok: false, error: '找不到可用的 node 运行时' }
  const port = Number(options.port || runtime?.port || config.port || DEFAULT_PORT)
  const argv = [path.join(PLUGIN_ROOT, 'bin', 'pac.js'), '--port', String(port), '--split', normalizeSplit(options.split) || config.split || 'cn-direct']
  if (options.out) argv.push('--out', options.out)
  try {
    const { stdout } = await execFileAsync(nodePath, argv, {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      timeout: 20000,
    })
    const r = JSON.parse(String(stdout).trim())
    return { ok: true, ...r }
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 240) }
  }
}

// --- system proxy: three modes + guard ----------------------------------------
//
// Clash Verge Rev calls this pair 「系统代理和守卫」, and the guard is the half
// that actually matters: writing the registry is trivial, but Windows' own
// auto-detect, another VPN client, or group policy can silently flip it back -
// and then the user believes traffic is being split when it is not.
//
//   off    - restore the snapshot; no snapshot means we never touched it
//   pac    - AutoConfigURL -> our proxy.pac, so the browser decides per domain
//            (domestic direct, foreign via 127.0.0.1:port)
//   global - ProxyServer=127.0.0.1:port, every honoring app reaches our listener
//            and the split rules then decide what really enters the tunnel
//
// Snapshot discipline: the baseline is captured once per off -> on transition.
// Switching pac <-> global must NOT re-snapshot, or the snapshot would record
// *our own* setting as the user's baseline and restore could never return the
// machine to a clean state.
const SYS_MODES = ['off', 'pac', 'global']
let sysGuard = null

function sysModeFromRegistry(values) {
  const enable = values.ProxyEnable ? String(values.ProxyEnable.data).toLowerCase() : ''
  if (!(enable === '0x1' || enable === '1')) return 'off'
  const pac = values.AutoConfigURL ? String(values.AutoConfigURL.data) : ''
  if (pac && /proxy\.pac/i.test(pac)) return 'pac'
  const server = values.ProxyServer ? String(values.ProxyServer.data) : ''
  if (server.startsWith('127.0.0.1:')) return 'global'
  // On, but not pointing at us: somebody else's proxy. Recorded, never overwritten
  // without an explicit mode request.
  return 'foreign'
}

function pacFileUrl() {
  return `file:///${path.join(RUNTIME_DIR, 'proxy.pac').replace(/\\/g, '/')}`
}

/** 只写目标档位需要的注册表值；不碰快照（由调用方决定是否采集）。 */
async function writeSysMode(mode, port) {
  if (mode === 'global') {
    // PAC wins over ProxyServer, so a leftover script would silently disable global mode
    await regDelete('AutoConfigURL')
    await regDelete('AutoDetect')
    await regSet('ProxyServer', 'REG_SZ', `127.0.0.1:${port}`)
    await regSet('ProxyEnable', 'REG_DWORD', '1')
  } else if (mode === 'pac') {
    // ProxyServer is removed on purpose: if the PAC fails to parse, the fallback
    // should be direct, not some stale proxy address.
    await regDelete('ProxyServer')
    await regDelete('AutoDetect')
    await regSet('AutoConfigURL', 'REG_SZ', pacFileUrl())
    await regSet('ProxyEnable', 'REG_DWORD', '1')
  }
  return sysModeFromRegistry(await regQueryAll())
}

function detectSysDrift(mode, values, port) {
  const drift = []
  const enable = values.ProxyEnable ? String(values.ProxyEnable.data).toLowerCase() : '(不存在)'
  if (!(enable === '0x1' || enable === '1')) drift.push(`ProxyEnable=${enable}（应为 1）`)
  if (mode === 'global') {
    const server = values.ProxyServer ? String(values.ProxyServer.data) : '(不存在)'
    if (server !== `127.0.0.1:${port}`) drift.push(`ProxyServer=${server}（应为 127.0.0.1:${port}）`)
  } else if (mode === 'pac') {
    const pac = values.AutoConfigURL ? String(values.AutoConfigURL.data) : '(不存在)'
    if (pac !== pacFileUrl()) drift.push(`AutoConfigURL=${pac}（应为 ${pacFileUrl()}）`)
  }
  return drift
}

function stopSysGuard(reason) {
  if (!sysGuard) return null
  const report = { mode: sysGuard.mode, checks: sysGuard.checks, repairs: sysGuard.repairs.length, reason: reason || 'stopped' }
  clearInterval(sysGuard.timer)
  sysGuard = null
  return report
}

function startSysGuard(mode, port, intervalSec) {
  stopSysGuard('restart')
  const sec = Math.max(10, Number(intervalSec) || 30)
  const state = { mode, port, intervalSec: sec, startedAt: Date.now(), checks: 0, repairs: [], lastCheck: 0, lastDrift: null, timer: null }
  state.timer = setInterval(() => { void sysGuardTick(state) }, sec * 1000)
  // unref so the guard never keeps the host process alive on its own
  state.timer.unref?.()
  sysGuard = state
  return state
}

async function sysGuardTick(state) {
  if (sysGuard !== state) return // a newer guard replaced this one
  try {
    state.checks++
    state.lastCheck = Date.now()
    // Proxy gone => a system proxy pointing at a dead port is worse than none.
    // Restore and retire the guard instead of looping on a broken setup.
    if (!runtime || !runtime.pid || !processAlive(runtime.pid)) {
      const restored = await restoreSystemProxy()
      state.repairs.push({ at: new Date().toISOString(), drift: ['代理已不在运行'], action: '还原注册表并停守卫', ok: restored?.ok === true })
      stopSysGuard('proxy-gone')
      return
    }
    const drift = detectSysDrift(state.mode, await regQueryAll(), state.port)
    state.lastDrift = drift.length ? drift : null
    if (drift.length) {
      const nowMode = await writeSysMode(state.mode, state.port)
      state.repairs.push({ at: new Date().toISOString(), drift, action: `写回 ${state.mode}`, nowMode })
      if (state.repairs.length > 20) state.repairs.splice(0, state.repairs.length - 20)
    }
  } catch (error) {
    state.lastDrift = [`守卫异常：${String(error?.message || error).slice(0, 160)}`]
  }
}

async function setSysProxyMode(mode, options = {}) {
  const config = loadConfig()
  const port = Number(runtime?.port || config.port || DEFAULT_PORT)

  if (mode === 'off') {
    const guardStopped = stopSysGuard('mode-off')
    const restored = await restoreSystemProxy()
    return { ok: restored?.ok === true, mode: 'off', restored, guardStopped }
  }

  if (!runtime || !runtime.pid || !processAlive(runtime.pid)) {
    return {
      ok: false,
      mode: null,
      error: '代理没在运行。先 local_proxy_start 再开系统代理——否则会把系统流量指向一个死端口，等于自己给自己断网。',
    }
  }

  let pacInfo = null
  if (mode === 'pac') {
    pacInfo = await generatePac({ port, split: options.split })
    if (!pacInfo?.ok) return { ok: false, mode: null, error: `PAC 生成失败：${pacInfo?.error || '未知'}` }
  }

  // 只在 off -> on 采集一次基线（见上方 snapshot discipline 注释）
  const hadSnapshot = Boolean(readSnapshot())
  if (!hadSnapshot) writeSnapshot(await takeSnapshot())

  const nowMode = await writeSysMode(mode, port)
  const verification = verifyRegistry(await regQueryAll(), readSnapshot())
  const guard = options.guard === false ? stopSysGuard('disabled') : startSysGuard(mode, port, options.guardSec)

  return {
    ok: nowMode === mode,
    mode: nowMode,
    requested: mode,
    port,
    pacUrl: mode === 'pac' ? pacFileUrl() : null,
    pacBytes: pacInfo?.bytes ?? null,
    guard: guard ? { mode: guard.mode, intervalSec: guard.intervalSec } : null,
    snapshot: hadSnapshot ? 'reused' : 'captured',
    snapshotPath: SNAPSHOT_PATH,
    problems: verification.problems,
  }
}

function verifyRegistry(values, snapshot) {
  const problems = []
  const expected = snapshot && snapshot.values ? snapshot.values : null
  const check = (valueName, absentIsOk, alsoClean) => {
    const current = values[valueName]
    const original = expected ? expected[valueName] : null
    if (original && original.exists === true) {
      if (!current) problems.push(`${valueName} 应存在但缺失`)
      else if (String(current.data).toLowerCase() !== String(original.data).toLowerCase()) {
        problems.push(`${valueName} 应为 ${original.data}，实际 ${current.data}`)
      }
      return
    }
    if (absentIsOk && current === undefined) return
    // 有些值「存在但内容就是关闭态」也算干净。ProxyEnable=0 是 Windows 的
    // 正常出厂状态（含义＝系统代理关闭），不是我们留下的脏数据。
    // 实测 2026-10-22 00:38：用户机器一直是 0x0，旧断言却把 status 报成
    // baselineOk:false，制造了「注册表没还原干净」的假警。
    if (current !== undefined && typeof alsoClean === 'function' && alsoClean(String(current.data))) return
    if (current !== undefined) problems.push(`${valueName} 应不存在，实际 ${current.data}`)
  }
  check('ProxyEnable', false, (d) => d.toLowerCase() === '0x0' || d === '0')
  check('ProxyServer', true)
  check('AutoConfigURL', true)
  check('AutoDetect', true)
  const pac = values.AutoConfigURL
  if (pac && String(pac.data).trim() !== '') problems.push('AutoConfigURL 仍有值')
  return {
    ok: problems.length === 0,
    problems,
    current: {
      ProxyEnable: values.ProxyEnable ? values.ProxyEnable.data : '(absent)',
      ProxyServer: values.ProxyServer ? values.ProxyServer.data : '(absent)',
      AutoConfigURL: values.AutoConfigURL ? values.AutoConfigURL.data : '(absent)',
      AutoDetect: values.AutoDetect ? values.AutoDetect.data : '(absent)',
      ProxyOverride: values.ProxyOverride ? values.ProxyOverride.data : '(absent)',
    },
  }
}

// --- process helpers ---------------------------------------------------------

function resolveRuntimeNode() {
  const explicit = process.env.LOCAL_PROXY_NODE || ''
  if (explicit && fs.existsSync(explicit)) return explicit
  const execPath = process.execPath || ''
  const base = execPath ? path.basename(execPath).toLowerCase() : ''
  if (base === 'node.exe' || base === 'node') return execPath
  // DSH's own node on this host outranks the Electron binary: fewer surprises.
  for (const candidate of ['D:\\ccd\\node.exe', 'C:\\Program Files\\nodejs\\node.exe']) {
    if (fs.existsSync(candidate)) return candidate
  }
  // Electron binary: ELECTRON_RUN_AS_NODE makes it behave as plain node.
  return execPath
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    try {
      server.listen(port, '127.0.0.1')
    } catch {
      resolve(false)
    }
  })
}

function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = async () => {
      if (await portFree(port)) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, 120)
    }
    tick()
  })
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) {
      resolve(true)
      return
    }
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', () => finish(true))
  })
}

function probeSocksGreeting(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let buffered = Buffer.alloc(0)
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('error', () => finish(false))
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length >= 2) finish(buffered[0] === 0x05 && buffered[1] !== 0xff)
    })
  })
}

// --- proxy self checks -------------------------------------------------------

function connectTcp(host, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`connect timeout ${host}:${port}`))
    }, timeoutMs)
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

function readHead(socket, timeoutMs, initial = '') {
  return new Promise((resolve, reject) => {
    let data = initial
    let done = false
    if (data.includes('\r\n')) {
      resolve(data)
      return
    }
    const timer = setTimeout(() => finish(new Error('response timeout')), timeoutMs)
    function finish(error) {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      try {
        socket.destroy()
      } catch {}
      if (error) reject(error)
      else resolve(data)
    }
    function onData(chunk) {
      data += chunk.toString('latin1')
      if (data.includes('\r\n')) finish(null)
      else if (data.length > 32 * 1024) finish(null)
    }
    socket.on('data', onData)
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(null))
  })
}

// Buffered reader for the client side of a SOCKS5 handshake: the reply to one
// step can arrive glued to the next, so bytes must never be discarded.
function createReader(socket) {
  let buffered = Buffer.alloc(0)
  let waiter = null
  let failure = null

  const settle = () => {
    if (!waiter) return
    if (failure) {
      const current = waiter
      waiter = null
      current.reject(failure)
      return
    }
    if (buffered.length >= waiter.need) {
      const out = buffered.subarray(0, waiter.need)
      buffered = buffered.subarray(waiter.need)
      const current = waiter
      waiter = null
      current.resolve(out)
    }
  }
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    settle()
  }
  const onError = (error) => {
    failure = error
    settle()
  }
  const onClose = () => {
    if (!failure) failure = new Error('socket closed')
    settle()
  }
  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)

  return {
    read(need, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (failure) {
          reject(failure)
          return
        }
        const timer = setTimeout(() => {
          if (waiter) {
            waiter = null
            reject(new Error('read timeout'))
          }
        }, timeoutMs || 4000)
        waiter = {
          need,
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        }
        settle()
      })
    },
    drain() {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      return buffered
    },
  }
}

async function httpViaProxy(proxyPort, targetUrl) {
  const url = new URL(targetUrl)
  const socket = await connectTcp('127.0.0.1', proxyPort, 4000)
  socket.write(
    `GET ${url.href} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\nProxy-Connection: close\r\n\r\n`,
  )
  const head = await readHead(socket, 6000)
  const statusLine = head.split('\r\n')[0] || ''
  const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine)
  if (!match) throw new Error(`代理返回了非 HTTP 响应: ${statusLine.slice(0, 60) || '(empty)'}`)
  return Number(match[1])
}

async function socksViaProxy(proxyPort, host, port, pathname = '/') {
  const socket = await connectTcp('127.0.0.1', proxyPort, 4000)
  const reader = createReader(socket)
  socket.write(Buffer.from([0x05, 0x01, 0x00]))
  const greeting = await reader.read(2, 4000)
  if (greeting[0] !== 0x05 || greeting[1] !== 0x00) throw new Error('SOCKS5 握手失败')
  const name = Buffer.from(host, 'utf8')
  const head = Buffer.from([0x05, 0x01, 0x00, 0x03, name.length])
  const tail = Buffer.from([(port >> 8) & 0xff, port & 0xff])
  socket.write(Buffer.concat([head, name, tail]))
  const reply = await reader.read(4, 4000)
  if (reply[1] !== 0x00) throw new Error(`SOCKS5 CONNECT 被拒绝(code ${reply[1]})`)
  const atyp = reply[3]
  if (atyp === 0x01) await reader.read(6, 4000)
  else if (atyp === 0x04) await reader.read(18, 4000)
  else if (atyp === 0x03) {
    const len = (await reader.read(1, 4000))[0]
    await reader.read(len + 2, 4000)
  }
  const leftover = reader.drain()
  socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`)
  const head2 = await readHead(socket, 6000, leftover.toString('latin1'))
  const statusLine = head2.split('\r\n')[0] || ''
  const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine)
  if (!match) throw new Error(`SOCKS 隧道内未拿到 HTTP 响应: ${statusLine.slice(0, 60) || '(empty)'}`)
  return Number(match[1])
}

function readExact(socket, count, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    let done = false
    const timer = setTimeout(() => finish(new Error('read timeout')), timeoutMs)
    function finish(error, value) {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      if (error) reject(error)
      else resolve(value)
    }
    function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length >= count) finish(null, buffered.subarray(0, count))
    }
    socket.on('data', onData)
    socket.once('error', (error) => finish(error))
  })
}

async function pickLocalTarget() {
  const candidates = [
    Number(process.env.DSH_WEB_PORT) || 13382,
    13382,
    19388,
  ]
  for (const port of [...new Set(candidates)]) {
    try {
      const socket = await connectTcp('127.0.0.1', port, 800)
      socket.destroy()
      return port
    } catch {
      // keep looking
    }
  }
  return null
}

// Local-only checks always run; the external one is opt-in because this host
// has no guaranteed egress and a blocked exit must not read as a broken proxy.
async function runSelftest(port, options = {}) {
  const checks = []
  const target = await pickLocalTarget()

  checks.push({
    name: 'port-listening',
    pass: await probeSocksGreeting(port),
    detail: `127.0.0.1:${port} 应答 SOCKS5 握手`,
    command: `netstat -ano | findstr LISTENING | findstr :${port}`,
  })

  if (target === null) {
    checks.push({
      name: 'local-http',
      pass: true,
      skipped: true,
      detail: '本机没有可当靶子的 HTTP 服务（13382/19388 均未监听），跳过本机通道检查',
      command: `curl -x http://127.0.0.1:${port} http://127.0.0.1:13382/`,
    })
    checks.push({
      name: 'local-socks5',
      pass: true,
      skipped: true,
      detail: '同上，跳过 SOCKS5 通道检查',
      command: `curl -x socks5h://127.0.0.1:${port} http://127.0.0.1:13382/`,
    })
  } else {
    try {
      const status = await httpViaProxy(port, `http://127.0.0.1:${target}/`)
      checks.push({
        name: 'local-http',
        pass: status > 0,
        detail: `HTTP 代理通道 → 127.0.0.1:${target}，状态 ${status}`,
        command: `curl -x http://127.0.0.1:${port} http://127.0.0.1:${target}/ -o NUL -w "%{http_code}"`,
      })
    } catch (error) {
      checks.push({
        name: 'local-http',
        pass: false,
        detail: `HTTP 代理通道失败：${error.message}`,
        command: `curl -x http://127.0.0.1:${port} http://127.0.0.1:${target}/`,
      })
    }
    try {
      const status = await socksViaProxy(port, '127.0.0.1', target, '/')
      checks.push({
        name: 'local-socks5',
        pass: status > 0,
        detail: `SOCKS5 通道 → 127.0.0.1:${target}，状态 ${status}`,
        command: `curl -x socks5h://127.0.0.1:${port} http://127.0.0.1:${target}/ -o NUL -w "%{http_code}"`,
      })
    } catch (error) {
      checks.push({
        name: 'local-socks5',
        pass: false,
        detail: `SOCKS5 通道失败：${error.message}`,
        command: `curl -x socks5h://127.0.0.1:${port} http://127.0.0.1:${target}/`,
      })
    }
  }

  if (options.external === true) {
    try {
      const socket = await connectTcp('127.0.0.1', port, 4000)
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
      const greeting = await readExact(socket, 2, 4000)
      if (greeting[1] !== 0x00) throw new Error('握手失败')
      const host = 'api.ipify.org'
      const name = Buffer.from(host, 'utf8')
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([0x01, 0xbb]),
        ]),
      )
      const reply = await readExact(socket, 4, 6000)
      socket.destroy()
      checks.push({
        name: 'external-egress',
        pass: reply[1] === 0x00,
        detail: reply[1] === 0x00 ? 'SOCKS5h CONNECT api.ipify.org:443 成功' : `外网出口不可用（code ${reply[1]}）`,
        command: `curl -x socks5h://127.0.0.1:${port} https://api.ipify.org`,
      })
    } catch (error) {
      checks.push({
        name: 'external-egress',
        pass: false,
        detail: `外网出口不可用（${error.message}）——本机无可用出口时属正常`,
        command: `curl -x socks5h://127.0.0.1:${port} https://api.ipify.org`,
      })
    }
  }

  const required = checks.filter((check) => check.name !== 'external-egress')
  return {
    ok: required.every((check) => check.pass),
    degraded: target === null,
    port,
    target,
    checks,
  }
}

// --- start / stop ------------------------------------------------------------

function attachChild(child, info) {
  runtime = {
    child,
    pid: child.pid,
    port: info.port,
    upstream: info.upstream,
    logDir: info.logDir,
    startedAt: Date.now(),
    systemProxy: info.systemProxy,
    ready: false,
    stderr: '',
  }
  child.stderr.on('data', (chunk) => {
    if (runtime && runtime.child === child) runtime.stderr = `${runtime.stderr}${chunk}`.slice(-4000)
  })
  child.once('exit', () => {
    if (runtime && runtime.child === child) {
      runtime = null
      // Only the proxy went away. The core and its watcher are detached and may
      // still be running, so their tracking files must survive - see CORE_KEEP.
      clearRuntimeFiles({ scope: 'proxy' })
    }
  })
  if (!exitHookInstalled) {
    exitHookInstalled = true
    const killOnExit = () => {
      if (runtime && runtime.child) {
        try {
          runtime.child.kill()
        } catch {}
      }
    }
    process.on('exit', killOnExit)
    process.on('SIGINT', killOnExit)
    process.on('SIGTERM', killOnExit)
  }
}

function waitReady(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buffered = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`代理进程 ${timeoutMs}ms 内未就绪${runtime && runtime.stderr ? `：${runtime.stderr.trim().slice(0, 300)}` : ''}`))
    }, timeoutMs)
    const onData = (chunk) => {
      buffered += chunk.toString('utf8')
      const line = buffered.split(/\r?\n/).find((entry) => entry.startsWith('READY '))
      if (!line || settled) return
      settled = true
      clearTimeout(timer)
      try {
        resolve(JSON.parse(line.slice('READY '.length)))
      } catch (error) {
        reject(new Error(`代理启动行无法解析：${line}`))
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`代理进程提前退出(code ${code})${runtime && runtime.stderr ? `：${runtime.stderr.trim().slice(0, 300)}` : ''}`))
    })
  })
}

// Bring the user system proxy in line with the requested state, without
// assuming it is currently off: the panel can flip the switch on a running
// proxy, in either direction.
async function syncSystemProxy(port, want) {
  const current = await regQueryAll()
  const server = current.ProxyServer ? String(current.ProxyServer.data) : ''
  const pointsAtUs = server === `127.0.0.1:${port}`
  if (want && !pointsAtUs) {
    const applied = await applySystemProxy(port)
    if (!applied.applied) {
      await restoreSystemProxy()
      throw new Error(`系统代理未生效（ProxyEnable=${applied.ProxyEnable}），已回滚`)
    }
    return { action: 'applied', applied }
  }
  if (!want && pointsAtUs) {
    const restored = await restoreSystemProxy()
    if (!restored.ok) throw new Error(`系统代理未能完全还原：${restored.verification.problems.join('；')}`)
    return { action: 'restored' }
  }
  return { action: 'unchanged' }
}


// --- sing-box node bridge --------------------------------------------------
// nodes.txt holds VLESS/REALITY URIs exported from the FoxLink client. One of
// them is run through the bundled sing-box.exe as a local SOCKS5 listener, and
// proxy.js is pointed at it as its upstream. Both halves start and stop
// together so the panel switch stays a single switch.
const SINGBOX_JS = path.join(PLUGIN_ROOT, 'bin', 'singbox-node.js')
const SINGBOX_PORT = 18999

async function runSingboxNode(action, arg, options = {}) {
  const nodePath = resolveRuntimeNode()
  if (!nodePath) throw new Error('找不到可用的 node 运行时')
  const argv = [SINGBOX_JS, action]
  if (arg) argv.push(String(arg))
  if (action === 'start' || action === 'reload' || action === 'watch') {
    argv.push('--port', String(options.port || SINGBOX_PORT))
  }
  for (const [k, v] of Object.entries(options.flags || {})) {
    if (v === undefined || v === null || v === '' || v === false) continue
    argv.push(k, String(v))
  }
  // `probe` dials every node for real; the default 20 s would cut it off
  // mid-run and look like a crash.
  const timeout = options.timeout || (action === 'probe' ? 900000 : 20000)
  try {
    const { stdout } = await execFileAsync(nodePath, argv, {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    })
    const text = String(stdout || '').trim()
    // Some subcommands print pretty multi-line JSON, others one line. Try the
    // whole payload first, then fall back to the last non-empty line.
    try {
      return JSON.parse(text)
    } catch {
      const last = text.split(/\r?\n/).filter(Boolean).pop() || '{}'
      return JSON.parse(last)
    }
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error)
    throw new Error(`节点操作失败（${action}）：${detail.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ')}`)
  }
}

// Flags shared by every node-pool subcommand, derived from the saved config so
// the panel switch and the tools always drive the same node file and policy.
function poolFlags(config, extra = {}) {
  const f = {}
  const nodesFile = extra.nodes || config.nodes
  if (nodesFile) f['--nodes'] = nodesFile
  f['--split'] = extra.split || config.split
  if (extra.top != null ? extra.top : config.top) f['--top'] = String(extra.top != null ? extra.top : config.top)
  // urltest tuning: harmless in single mode (ignored there), consumed by the
  // race group builder in bin/singbox-node.js.
  if (config.urltestInterval) f['--interval'] = String(config.urltestInterval)
  if (config.urltestTolerance != null) f['--tolerance'] = String(config.urltestTolerance)
  return f
}

async function singboxStatus() {
  try {
    return await runSingboxNode('status')
  } catch {
    return { running: false }
  }
}

// --- DSH 自身接线（详见 src/host-wire.js 文件头）---------------------------
// 起代理 ≠ DSH 自己会走这个代理：桌面版启动路径不装进程内 dispatcher，
// web_fetch 永远直连。wireDsh 开时，这一层把 127.0.0.1:<port> 装进宿主，
// 关停时卸下；日志单独落 .runtime/host-wire.log，便于「装没装」直接取证。
const WIRE_LOG_PATH = path.join(RUNTIME_DIR, 'host-wire.log')
// apply() 里存下的 cordis ctx：launchEnvironmentOf(ctx) 要用它读 .env 层的显式代理。
let hostCtx = null
function wireLog(line) {
  const stamp = new Date().toISOString()
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.appendFileSync(WIRE_LOG_PATH, `${stamp} ${line}\n`, 'utf8')
  } catch {}
  return line
}
async function wireIfEnabled(config, port) {
  if (!config.wireDsh) return { ok: false, action: 'disabled' }
  try {
    return await wireHostProxy({ preferUrl: `http://127.0.0.1:${port}`, ctx: hostCtx, log: wireLog })
  } catch (error) {
    wireLog(`接线异常（不影响代理本身）：${error?.message ?? error}`)
    return { ok: false, action: 'error', error: String(error?.message ?? error) }
  }
}

function wireSummaryLine(w) {
  if (!w) return null
  if (w.action === 'disabled') return null
  if (w.action === 'installed') return `DSH 自身：已接上 ${w.proxyUrl}（来源 ${w.source}，google 走代理=${w.proxiedSelfCheck}）`
  if (w.action === 'already') return `DSH 自身：已在 ${w.proxyUrl}`
  if (w.action === 'none') return 'DSH 自身：未找到可用回环代理，保持直连（什么都没改）'
  if (w.action === 'error') return `DSH 自身：接线失败，保持直连（${w.error}）`
  if (w.action === 'unchanged-but-differs') return `DSH 自身：已装着 ${w.proxyUrl}，本次候选 ${w.wanted} 未生效（先 stop 再 start）`
  return `DSH 自身：${w.action}`
}

async function startProxy(options = {}) {
  // 清扫闸门：apply 尾部的 sweepSurvivors 是 await 串（findWatcherPid → 查 18999
  // → readStateFile → killPid，全程 1~2 秒）。/start 撞进这个窗口时，新起的
  // proxy.js 刚登记进 runtime/state.json，慢一拍到的清扫步就把它当上轮遗留杀掉
  // ——外部 taskkill 不写 stop 日志，表现为「selftest 全过后端口凭空消失」且随机
  // 复发（headless 套件 2026-10-22 07:4x/07:5x 两轮红两轮绿就是这么来的）。
  // sweepSurvivors 里加了 runtime 二次确认作为第二道闸，这里是根治：串行。
  if (reconcileInFlight) {
    try { await reconcileInFlight } catch {}
  }
  const config = normalizeConfig({ ...loadConfig(), ...(options || {}) })

  if (runtime && runtime.child && runtime.child.exitCode === null) {
    // Already up: honour a system-proxy toggle instead of ignoring it, so the
    // panel switch works on a running proxy. Off means "put the registry back"
    // while the listener keeps running.
    const sync = await syncSystemProxy(runtime.port, config.systemProxy)
    saveConfig(config)
    const wire = await wireIfEnabled(config, runtime.port)
    return {
      ok: true,
      already: true,
      registryAction: sync.action,
      hostWire: wire,
      systemProxyApplied: sync.applied ? sync.applied.applied : undefined,
      message:
        sync.action === 'applied'
          ? `代理已在运行（127.0.0.1:${runtime.port}），系统代理已开启`
          : sync.action === 'restored'
            ? `代理仍在运行（127.0.0.1:${runtime.port}），系统代理已还原`
            : `代理已在运行（127.0.0.1:${runtime.port}）`,
      status: await statusSnapshot(),
    }
  }

  const orphan = readStateFile()
  if (orphan && processAlive(orphan.pid) && (await probeSocksGreeting(orphan.port))) {
    runtime = {
      child: null,
      pid: orphan.pid,
      port: orphan.port,
      upstream: orphan.upstream || '',
      logDir: orphan.logDir || config.logDir,
      startedAt: orphan.startedAt || Date.now(),
      systemProxy: orphan.systemProxy === true,
      ready: true,
      stderr: '',
      adopted: true,
    }
    return {
      ok: true,
      already: true,
      adopted: true,
      hostWire: await wireIfEnabled(config, runtime.port),
      message: `接管上一轮遗留的代理进程（pid ${orphan.pid}, 127.0.0.1:${orphan.port}）`,
      status: await statusSnapshot(),
    }
  }

  if (!(await portFree(config.port))) {
    throw new Error(`端口 ${config.port} 已被其它进程占用，换一个端口再试`)
  }

  const nodePath = resolveRuntimeNode()
  if (!nodePath) throw new Error('找不到可用的 node 运行时')

  try {
    fs.mkdirSync(config.logDir, { recursive: true })
  } catch {
    // the proxy falls back to no file logging if the directory is unavailable
  }

  const args = [
    PROXY_JS,
    '--port',
    String(config.port),
    '--host',
    '127.0.0.1',
    '--log-dir',
    config.logDir,
    '--pid-file',
    path.join(RUNTIME_DIR, 'proxy.pid'),
    '--parent-pid',
    String(process.pid),
  ]
  if (config.upstream) args.push('--upstream', config.upstream)

  const child = spawn(nodePath, args, {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  attachChild(child, config)

  let ready
  try {
    ready = await waitReady(child)
    runtime.ready = true
  } catch (error) {
    try {
      child.kill()
    } catch {}
    runtime = null
    clearRuntimeFiles()
    throw error
  }

  writeStateFile({
    pid: child.pid,
    port: runtime.port,
    upstream: config.upstream,
    logDir: config.logDir,
    startedAt: runtime.startedAt,
    systemProxy: config.systemProxy,
    node: nodePath,
  })
  saveConfig(config)

  const result = {
    ok: true,
    started: true,
    port: runtime.port,
    pid: runtime.pid,
    upstream: config.upstream || 'direct',
    ready,
  }

  if (config.systemProxy) {
    let sync
    try {
      sync = await syncSystemProxy(config.port, true)
    } catch (error) {
      const stopped = await stopProxy()
      throw new Error(`系统代理写入失败，已回滚：${error.message}${stopped.ok ? '' : '（回滚仍有项未复位）'}`)
    }
    result.systemProxy = sync.applied
    result.systemProxyApplied = sync.action === 'applied' || sync.action === 'unchanged'
    runtime.systemProxy = true
    try {
      const state = readStateFile()
      if (state) writeStateFile({ ...state, systemProxy: true })
    } catch {}
  }

  const selftest = await runSelftest(runtime.port)
  result.selftest = selftest
  if (!selftest.ok) {
    const stopped = await stopProxy()
    return {
      ok: false,
      started: false,
      message: '代理进程已起但连通性自检失败，已自动关停',
      selftest,
      stop: stopped,
      status: await statusSnapshot(),
    }
  }
  // 自检过了才接线：代理自己都不通就别把宿主 traffic 往它身上引。
  result.hostWire = await wireIfEnabled(config, runtime.port)
  result.status = await statusSnapshot()
  return result
}

async function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true })
      return true
    } catch {
      return false
    }
  }
}

async function stopProxy() {
  const config = loadConfig()
  const report = { ok: true, actions: [], port: null, registry: null }
  // The guard goes first: left running, it would write the system proxy straight
  // back while this function is restoring it. Its own "proxy gone -> restore"
  // branch is a safety net for crashes, not something the normal stop path
  // should rely on.
  const guardStopped = stopSysGuard('stop')
  if (guardStopped) report.actions.push(`守卫已停（巡检 ${guardStopped.checks} 次、写回 ${guardStopped.repairs} 次）`)
  // 先卸宿主自身的代理策略：进程都要杀了，留着 dispatcher 会让 web_fetch 指向死端口。
  try {
    const wireDown = await unwireHostProxy({ log: wireLog })
    if (wireDown.action === 'disposed') report.actions.push(`DSH 自身代理策略已卸下（原 ${wireDown.proxyUrl}）`)
  } catch (error) {
    report.actions.push(`DSH 自身代理策略卸下失败（重启宿主即清）：${error?.message ?? error}`)
  }
  let child = runtime && runtime.child ? runtime.child : null
  let pid = runtime && runtime.pid ? runtime.pid : null
  let port = runtime && runtime.port ? runtime.port : null

  // Adopt a leftover from a previous host boot: state.json + a live SOCKS5
  // answer on that port is specific enough to stop without touching anything
  // else on the machine.
  if (!pid) {
    const state = readStateFile()
    if (state && processAlive(state.pid) && (await probeSocksGreeting(state.port))) {
      pid = state.pid
      port = state.port
      report.actions.push(`adopted leftover pid ${pid} on ${port}`)
    }
  }

  if (pid) {
    report.port = port
    if (child) {
      try {
        child.stdin.end()
        report.actions.push('sent stdin EOF')
      } catch {}
      const exited = await waitExit(child, 2500)
      if (exited) report.actions.push('child exited gracefully')
      else {
        try {
          child.kill()
        } catch {}
        report.actions.push('sent SIGTERM')
        if (!(await waitExit(child, 1500))) {
          try {
            await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true })
            report.actions.push('taskkill /F')
          } catch {}
          await waitExit(child, 1500)
        }
      }
    } else {
      await killPid(pid)
      report.actions.push(`sent SIGTERM to pid ${pid}`)
    }
  } else {
    report.actions.push('no running proxy recorded')
  }

  if (port) {
    report.portFree = await waitPortFree(port, 5000)
    report.actions.push(report.portFree ? 'port released' : 'port still busy after 5s')
  }

  const snapshotExists = fs.existsSync(SNAPSHOT_PATH)
  let snapshotHandled = false
  if (snapshotExists) {
    const registry = await restoreSystemProxy()
    report.registry = registry
    snapshotHandled = true
    report.actions.push(`registry restored (${registry.method})`)
    if (!registry.ok) report.ok = false
    if (registry.ok) report.actions.push('snapshot removed')
  } else {
    const values = await regQueryAll()
    const proxyServer = values.ProxyServer ? String(values.ProxyServer.data) : ''
    // No snapshot: only a server string that is exactly this plugin's listener
    // is safe to undo. Any other loopback value was set by someone else, so it
    // is reported, not touched.
    const knownPorts = [port, config?.port, readStateFile()?.port].filter((value) => Number.isInteger(value))
    const ours = knownPorts.some((value) => proxyServer === `127.0.0.1:${value}`)
    if (ours) {
      const registry = await restoreSystemProxy()
      report.registry = registry
      snapshotHandled = true
      report.actions.push('registry restored (no snapshot, system proxy pointed at this listener)')
      if (!registry.ok) report.ok = false
    } else {
      report.registry = { ok: true, skipped: true, current: verifyRegistry(values, null).current }
      report.actions.push(
        proxyServer
          ? `system proxy left untouched (ProxyServer=${proxyServer} was not set by this plugin)`
          : 'system proxy left untouched (never pointed at loopback)',
      )
    }
  }

  if (report.portFree === false) report.ok = false
  runtime = null
  clearRuntimeFiles({ dropSnapshot: snapshotHandled && report.registry && report.registry.ok !== false })
  if (port) {
    report.verified = {
      listening: !(await portFree(port)),
      portReusable: await portFree(port),
    }
    if (!report.verified.portReusable) report.ok = false
  }
  report.message = report.ok ? '代理已关停，端口已释放，系统代理已回到开前状态' : '代理已关停但仍有项未复位，见 actions/registry'
  return report
}

// After a host crash (or a hard kill) the child is gone but the registry may
// still point at the dead listener and the runtime files remain. Reconcile on
// load: adopt a live leftover, or restore the snapshot and clean up.
// --- restart survival --------------------------------------------------------
//
// The core and the watcher are detached, so they outlive the host. Their pid
// files are the only way a later `stop` can find them, and those files can be
// lost (crash, manual cleanup, or the wipe fixed by CORE_KEEP above). These
// helpers re-identify our own processes from the outside so nothing of ours is
// left running untracked - "关就完全关" has to hold after a restart too.

/** PID of whatever listens on 127.0.0.1:port, or null. */
async function pidListeningOn(port) {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
      if (m && Number(m[1]) === port) return Number(m[2])
    }
  } catch {}
  return null
}

/** Image name of a pid, lowercased, or '' when it cannot be read. */
async function processImageName(pid) {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const m = stdout.match(/^"([^"]+)"/)
    return m ? m[1].toLowerCase() : ''
  } catch {
    return ''
  }
}

/** PID of our own watcher, found by its command line, or null. */
async function findWatcherPid() {
  // PowerShell's -like does NOT treat backslash as an escape, so the pattern
  // must carry a single one - and matching on the script name alone is enough
  // to prove ownership, since that path only exists inside this plugin.
  // Measured: '*bin\\singbox-node.js*watch*' matched 0 processes,
  //           '*singbox-node.js*watch*'      matched the live watcher.
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*singbox-node.js*watch*' } | ForEach-Object { $_.ProcessId }",
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 20000 },
    )
    const pid = Number(String(stdout).trim().split(/\r?\n/)[0])
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

// Returns {ok, error} instead of a bare boolean: a silent `catch {}` here hid a
// ReferenceError for a whole test round, and "the pid file was not written" is
// only actionable when the reason comes with it.
function writeRuntimeFile(name, text) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(path.join(RUNTIME_DIR, name), `${text}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/**
 * Sweep our own surviving processes instead of adopting them.
 *
 * Contract (user, 2026-10-21 23:56): 「只要关了 dsh 就全关了，像没有 vpn 一样」.
 * While DSH is not running the VPN must not exist. So a survivor found at host
 * startup means the last shutdown was abnormal (crash, taskkill on the host,
 * power loss) and the teardown hook never fired - the right response is to
 * finish that teardown, not to keep the process alive.
 *
 * This replaces the earlier adopt-and-resume behaviour, which did the opposite
 * of what the user asked: it silently brought the proxy back on every start
 * (Fix D, added 23:41, withdrawn 23:57 the same day).
 *
 * Ownership is proven, never assumed: the core must be `sing-box.exe` on our
 * private port, the watcher must carry our own script path in its command line.
 * A foreign listener on 18999 is reported and never killed.
 */
async function sweepSurvivors() {
  const report = { watcher: null, core: null, proxy: null }
  const settle = (ms) => new Promise((r) => setTimeout(r, ms))

  // Watcher first: it is the process that resurrects a killed core, so sweeping
  // the core before it turns into whack-a-mole. Measured 2026-10-21 23:12 -
  // stop reported the core stopped and 18999 was listening again seconds later.
  const watchPid = await findWatcherPid()
  if (watchPid) {
    await killPid(watchPid)
    await settle(700)
    report.watcher = { pid: watchPid, gone: !processAlive(watchPid), swept: true }
  }

  const corePid = await pidListeningOn(SINGBOX_PORT)
  if (corePid) {
    const image = await processImageName(corePid)
    if (image === 'sing-box.exe') {
      await killPid(corePid)
      await settle(500)
      report.core = { pid: corePid, image, swept: true, portFree: await portFree(SINGBOX_PORT) }
    } else {
      report.core = { pid: corePid, image, swept: false, reason: '不是 sing-box.exe，端口被别人占了，不动它' }
    }
  }

  // A proxy from the previous session that somehow outlived its host goes too:
  // it is a listener on our port that nobody is tracking.
  const state = readStateFile()
  if (state && state.pid && processAlive(state.pid)) {
    if (runtime) {
      // 这已经是本进程自己管的代理（startProxy 已登记 runtime），不是遗留。
      // 没有这道闸时真实踩过：headless 测试 apply() 后立刻 /start，异步清扫慢一
      // 拍到 readStateFile 时把刚起的 proxy.js 当遗留杀掉——外部 taskkill 不写
      // stop 日志，现象是「selftest 全过后端口凭空消失」且非确定性复发。
      report.proxy = { pid: state.pid, swept: false, reason: 'runtime 已登记，这是本进程起的，不清' }
    } else {
      await killPid(state.pid)
      await settle(400)
      report.proxy = { pid: state.pid, swept: true, gone: !processAlive(state.pid), portFree: await portFree(state.port) }
    }
  }

  return report
}

// --- host shutdown: 「只要关了 dsh 就全关了，像没有 vpn 一样」 ------------------
//
// The proxy already dies with the host (it is our child). The core and the
// watcher are detached, so they survive - and that is exactly the pollution the
// user asked to remove: a forgotten process, an occupied port, and worst case a
// system proxy left pointing at a dead port, which silently breaks every other
// app on the machine.
//
// An 'exit' handler can only use synchronous APIs, so everything here is
// spawnSync with a hard timeout: a hung kill must never stop DSH from closing.
// Synchronous twins of the async probes, because an 'exit' handler cannot await.
function pidListeningOnSync(port) {
  try {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, encoding: 'utf8', timeout: 8000 })
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
      if (m && Number(m[1]) === Number(port)) return Number(m[2])
    }
  } catch {}
  return null
}

function imageOfSync(pid) {
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 8000 })
    const m = String(r.stdout || '').match(/^"([^"]+)"/)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

function findWatcherPidsSync() {
  // PowerShell 的 -like 不把反斜杠当转义符，模式里不要写 \\ 路径（2026-10-21 踩过）
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*singbox-node.js*watch*' } | ForEach-Object { $_.ProcessId }"
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    })
    return String(r.stdout || '')
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid)
  } catch {
    return []
  }
}

let teardownRan = false
function teardownOnHostExit() {
  if (teardownRan) return
  teardownRan = true
  const killed = []
  const pids = []
  let watchPidFromFile = null
  for (const name of ['watch.pid', 'singbox.pid', 'proxy.pid', 'state.json']) {
    try {
      const raw = fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8').trim()
      const pid = name.endsWith('.json') ? Number(JSON.parse(raw)?.pid) : Number(raw)
      if (Number.isInteger(pid) && pid > 0) {
        pids.push(pid)
        if (name === 'watch.pid') watchPidFromFile = pid
      }
    } catch {}
  }
  if (runtime?.pid) pids.push(runtime.pid)

  // watch.pid is read first on purpose: the watcher must die before the core or
  // it simply starts the core again.
  for (const pid of [...new Set(pids)]) {
    try {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 4000 })
      killed.push({ pid, status: r.status })
    } catch (error) {
      killed.push({ pid, error: String(error?.message || error).slice(0, 120) })
    }
  }

  // The watcher is the one process that can undo everything above, so if its
  // pid file was missing we have to find it by command line. A synchronous CIM
  // query costs seconds, which is why it only runs on that rare path.
  if (!watchPidFromFile) {
    for (const wpid of findWatcherPidsSync()) {
      try {
        const r = spawnSync('taskkill', ['/PID', String(wpid), '/T', '/F'], { windowsHide: true, timeout: 4000 })
        killed.push({ pid: wpid, status: r.status, via: 'cim-sweep' })
      } catch {}
    }
  }

  // A pid file can be missing or stale while the process is not. Port truth
  // beats file truth, so sweep whatever still listens on our private port -
  // but only after proving the image is our own sing-box.exe. A foreign
  // listener is recorded and never killed.
  for (let round = 0; round < 2; round++) {
    const byPort = pidListeningOnSync(SINGBOX_PORT)
    if (!byPort) break
    if (imageOfSync(byPort) !== 'sing-box.exe') {
      killed.push({ pid: byPort, skipped: '不是 sing-box.exe，端口被别人占了，不动它' })
      break
    }
    try {
      const r = spawnSync('taskkill', ['/PID', String(byPort), '/T', '/F'], { windowsHide: true, timeout: 4000 })
      killed.push({ pid: byPort, status: r.status, via: 'port-sweep' })
    } catch {}
  }

  restoreSystemProxySync()
  // The pid/state files now describe dead processes. Derived caches (probe.json,
  // proxy.pac) stay so the next start does not need a two-minute re-probe.
  try { clearRuntimeFiles({ dropSnapshot: true }) } catch {}
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(RUNTIME_DIR, 'teardown.json'),
      `${JSON.stringify({ at: new Date().toISOString(), killed, proxyWasUp: Boolean(runtime) }, null, 2)}\n`,
      'utf8',
    )
  } catch {}
}

// Synchronous mirror of restoreSystemProxy for the exit handler: snapshot
// driven, so a value that did not exist before is deleted rather than
// rewritten as an empty string.
//
// No snapshot means this session never touched the system proxy, so the
// registry is not touched at all. Measured 2026-10-22 00:12: the first version
// ran the delete branch unconditionally and turned the user's pre-existing
// `ProxyEnable=0x0` into a missing value - functionally the same, but rewriting
// a machine setting we never owned is exactly what 「像没装过一样」 forbids.
function restoreSystemProxySync() {
  const snapshot = readSnapshot()
  if (!snapshot) return false
  const run = (args) => {
    try { spawnSync('reg', args, { windowsHide: true, timeout: 4000 }) } catch {}
  }
  for (const name of [...TOUCHED_VALUES, 'ProxyOverride']) {
    const original = snapshot?.values?.[name]
    if (original && original.exists === true) {
      run(['add', REG_KEY, '/v', name, '/t', original.type || 'REG_SZ', '/d', String(original.data ?? ''), '/f'])
    } else {
      run(['delete', REG_KEY, '/v', name, '/f'])
    }
  }
  try { fs.rmSync(SNAPSHOT_PATH, { force: true }) } catch {}
  return true
}

// Hooked once per process no matter how many times this module is imported
// (the survival test imports fresh copies with a cache-busting query).
if (!globalThis.__dshLocalProxyTeardownHooked) {
  globalThis.__dshLocalProxyTeardownHooked = true
  process.once('exit', teardownOnHostExit)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      teardownOnHostExit()
      process.exit(0)
    })
  }
}

// The node-file watcher runs detached so it can hot-reload the core in
// 0.2-0.4s when nodes.txt changes. Started the same way by the switch tool and
// by opt-in auto-start; bin/singbox-node.js writes watch.pid itself.
async function startNodeWatcher(options = {}) {
  const nodePath = resolveRuntimeNode()
  if (!nodePath) throw new Error('找不到可用的 node 运行时')
  const config = loadConfig()
  const argv = [SINGBOX_JS, 'watch', '--port', String(options.port ?? SINGBOX_PORT)]
  if (options.flags) {
    for (const [k, v] of Object.entries(options.flags)) argv.push(k, String(v))
  }
  const reprobeMin = Number(options.reprobeMin ?? config.reprobeMin)
  if (reprobeMin > 0) argv.push('--reprobe-min', String(reprobeMin))
  const logDir = config.logDir || DEFAULT_LOG_DIR
  fs.mkdirSync(logDir, { recursive: true })
  const logFd = fs.openSync(path.join(logDir, 'node-watch.log'), 'a')
  const child = spawn(nodePath, argv, {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  })
  child.unref()
  try { fs.closeSync(logFd) } catch {}
  // Written here, not left to the child: bin/singbox-node.js writes watch.pid
  // only once its own startup finishes, and the host can exit inside that
  // window. teardownOnHostExit locates the watcher through this file, so a
  // missing file means a surviving watcher that keeps resurrecting the core.
  const wPid = writeRuntimeFile('watch.pid', child.pid)
  return { pid: child.pid, logDir, wrotePid: wPid.ok, writeError: wPid.error || null }
}

async function reconcileOnLoad() {
  if (runtime) return { action: 'skip' }
  // 1) Finish the teardown of anything that survived an abnormal host death.
  const survivors = await sweepSurvivors()
  // 2) A dead session's system proxy must not stay behind.
  const hadSnapshot = fs.existsSync(SNAPSHOT_PATH)
  const restored = hadSnapshot ? await restoreSystemProxy() : null
  // 3) Every pid/state file now describes a dead process. Drop them, keep the
  //    derived caches so the next start skips the two-minute re-probe.
  clearRuntimeFiles({ dropSnapshot: !hadSnapshot || restored?.ok === true })

  const report = {
    action: 'swept',
    survivors,
    restored: restored ? { ok: restored.ok, problems: restored.verification.problems } : null,
  }
  // 4) Auto-start is opt-in and defaults to off: 「找我要求开就开，不要求开一般就不开」.
  report.autoStart = await autoStartIfConfigured()
  writeReconcileEvidence(report)
  return report
}

// What reconcile decided, and why, lands on disk: after a host restart there is
// no console to read, and "did it sweep my surviving core or miss it" must be
// answerable from evidence rather than from the resulting port state alone.
function writeReconcileEvidence(report) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(RUNTIME_DIR, 'reconcile.json'),
      `${JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2)}\n`,
      'utf8',
    )
  } catch {}
}

// Even when enabled this only brings up the loopback stack. The system proxy is
// never touched here - that stays an explicit user action.
async function autoStartIfConfigured() {
  let config
  try {
    config = loadConfig()
  } catch {
    return null
  }
  if (config.autoStart !== true) return null
  try {
    const res = await startProxy({})
    const watcher = await startNodeWatcher({ reprobeMin: config.reprobeMin })
    return { ok: res?.ok === true, port: runtime?.port ?? null, watcher: watcher?.pid ?? null }
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 240) }
  }
}

// --- status ------------------------------------------------------------------

async function statusSnapshot() {
  const config = loadConfig()
  const state = readStateFile()
  const port = runtime ? runtime.port : state ? state.port : config.port
  const pid = runtime ? runtime.pid : state ? state.pid : null
  const alive = pid ? processAlive(pid) : false
  const socks = await probeSocksGreeting(port, 700)
  const free = await portFree(port)
  const values = await regQueryAll()
  const registry = verifyRegistry(values, null)

  let logFile = ''
  try {
    const files = fs
      .readdirSync(config.logDir)
      .filter((entry) => entry.startsWith('local-proxy-'))
      .sort()
    logFile = files.length > 0 ? path.join(config.logDir, files[files.length - 1]) : ''
  } catch {}

  const running = alive && socks
  const orphan = !runtime && state !== null && alive && socks
  return {
    ok: true,
    running,
    orphan,
    hostWired: hostWiredState(),
    // 配置层的开关值（面板要显示"下次启动是否接线"），与 hostWired 的"当前实际是否已接上"是两件事：
    // 代理关停后 hostWired.wired 必然是 false，但 wireDsh 配置仍可以是 true。
    wireDsh: config.wireDsh === true,
    port,
    pid,
    upstream: (runtime && runtime.upstream) || (state && state.upstream) || config.upstream || 'direct',
    // 两个维度分开报：split 是「隧道规则怎么走」，sysMode 是「系统交不交给代理」。
    // 用户说的「直连/全局」在两个维度上都有对应物，混在一起报会误判。
    split: config.split,
    splitLabel: splitLabel(config.split),
    sysMode: sysModeFromRegistry(values),
    guard: sysGuard
      ? {
          mode: sysGuard.mode,
          intervalSec: sysGuard.intervalSec,
          checks: sysGuard.checks,
          repairs: sysGuard.repairs.length,
          lastDrift: sysGuard.lastDrift,
          uptimeSec: Math.round((Date.now() - sysGuard.startedAt) / 1000),
        }
      : null,
    systemProxy: {
      enabled: registry.current.ProxyEnable === '0x1' || registry.current.ProxyEnable === '1',
      server: registry.current.ProxyServer,
      pointsAtUs: String(registry.current.ProxyServer).includes(`127.0.0.1:${port}`),
      autoConfigURL: registry.current.AutoConfigURL,
      autoDetect: registry.current.AutoDetect,
      proxyOverride: registry.current.ProxyOverride,
    },
    baselineOk: registry.ok,
    portFree: free,
    config,
    logFile,
    startedAt: runtime ? runtime.startedAt : state ? state.startedAt : null,
    runtimeDir: RUNTIME_DIR,
    pluginRoot: PLUGIN_ROOT,
  }
}

function renderStatus(status) {
  const lines = []
  lines.push(status.running ? `运行中  127.0.0.1:${status.port}` : '已停止')
  if (status.orphan) lines.push('注意：检测到上一轮遗留进程（可用 local_proxy_stop 接管并关停）')
  lines.push(`上游：${status.upstream}`)
  lines.push(`分流：${status.splitLabel || status.split || '(未设)'}`)
  const sysNames = { off: '关闭', pac: 'PAC 分流', global: '全局代理', foreign: '⚠ 开着但不指向我们（别的软件设的，本插件不动它）' }
  lines.push(
    `系统代理：${sysNames[status.sysMode] || status.sysMode || '关闭'}` +
      `（ProxyEnable=${status.systemProxy.enabled ? 1 : 0}，ProxyServer=${status.systemProxy.server}）`,
  )
  lines.push(
    status.hostWired?.wired
      ? `DSH 自身：已接上 ${status.hostWired.proxyUrl}（来源 ${status.hostWired.source}，no_proxy=${status.hostWired.noProxy}）`
      : 'DSH 自身：未接线（web_fetch 等仍走直连；wireDsh=true 才会接）',
  )
  if (status.guard) {
    lines.push(
      `守卫：开着　档 ${status.guard.mode}　每 ${status.guard.intervalSec} 秒　已巡 ${status.guard.checks} 次　写回 ${status.guard.repairs} 次　在线 ${status.guard.uptimeSec} 秒`,
    )
    if (status.guard.lastDrift) lines.push(`      最近漂移：${status.guard.lastDrift.join('；')}`)
  }
  lines.push(`端口空闲：${status.portFree ? '是' : '否'}`)
  if (status.pid) lines.push(`PID：${status.pid}`)
  if (status.logFile) lines.push(`日志：${status.logFile}`)
  return lines.join('\n')
}

function renderSelftest(result) {
  const lines = [result.ok ? '自检通过' : '自检失败']
  for (const check of result.checks) {
    lines.push(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}  ${check.detail}`)
    lines.push(`      ${check.command}`)
  }
  return lines.join('\n')
}

// --- http --------------------------------------------------------------------

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const name = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

function guard(req, res) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' })
    return false
  }
  if (!isLocalHostHeader(req.headers.host)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = null
    }
    if (originHost !== null && !isLocalHostHeader(originHost)) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'cross-origin request' })
      return false
    }
  }
  return true
}

async function readJsonBody(req) {
  const raw = await readBody(req)
  if (!raw) return {}
  const parsed = JSON.parse(raw)
  return parsed && typeof parsed === 'object' ? parsed : {}
}

// --- tools -------------------------------------------------------------------

function toolResult(text) {
  return { text }
}

// --- shared implementation behind the switch tool AND the panel routes -------
//
// One body, two callers. Keeping the tool and the HTTP route on separate copies
// is how the panel ends up lying about what the tool actually did.

/** 探活缓存（.runtime/probe.json）。它是派生产物，停机后故意保留。 */
function readProbeCache() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'probe.json'), 'utf8'))
    const ranked = Array.isArray(d.ranked) ? d.ranked : []
    return {
      ok: true,
      file: d.file || null,
      testedAt: d.testedAt || null,
      ageMin: d.testedAt ? Math.round((Date.now() - Date.parse(d.testedAt)) / 60000) : null,
      total: d.total ?? ranked.length,
      alive: d.alive ?? ranked.filter((n) => n.pass).length,
      dead: d.dead ?? 0,
      retried: d.retried ?? 0,
      recoveredOnRetry: d.recoveredOnRetry ?? 0,
      latencyMs: d.latencyMs || null,
      countries: d.countries || [],
      baseline: d.baseline || null,
      byKind: d.byKind || null,
      // 面板要的就是这份：已按延迟排好序，rank 从 1 开始
      ranked: ranked.map((n, i) => ({
        rank: i + 1,
        tag: n.tag,
        type: n.type,
        kind: n.kind,
        server: n.server,
        port: n.port,
        ms: Number.isFinite(n.ms) ? n.ms : null,
        pass: n.pass === true,
        egress: n.egress || null,
        error: n.error || '',
      })),
    }
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 200), ranked: [] }
  }
}

/**
 * 当前出口，实测两遍：经代理 + 直连对照。
 * 故意不放进 status 轮询——每次要 1~3 秒真实网络往返，2.5 秒刷新一次会把
 * 面板和上游都拖死。面板上做成按钮，点了才测。
 */
async function measureEgress(port) {
  const one = async (useProxy) => {
    const args = ['-s', '--max-time', '15']
    if (useProxy) args.push('-x', `http://127.0.0.1:${port}`)
    else args.push('--noproxy', '*')
    args.push('https://myip.ipip.net')
    const t0 = Date.now()
    try {
      const { stdout } = await execFileAsync('curl.exe', args, { windowsHide: true, timeout: 20000 })
      const text = String(stdout).trim()
      const ip = (text.match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || null
      return { ok: text.length > 0, ip, text, ms: Date.now() - t0 }
    } catch (error) {
      return { ok: false, ip: null, text: '', ms: Date.now() - t0, error: String(error?.message || error).slice(0, 160) }
    }
  }
  const [proxied, direct] = await Promise.all([one(true), one(false)])
  return {
    ok: true,
    proxied,
    direct,
    // 两个 IP 不同才说明隧道真的在承载流量；相同说明要么直连档、要么隧道没生效
    differs: Boolean(proxied.ip && direct.ip && proxied.ip !== direct.ip),
  }
}

async function applySwitch(args) {
  const lines = []
  const out = { ok: true }
  try {
    // 1) 分流档：中英文都认。不认的词明确报「未改动」，绝不静默按默认档跑。
    if (args?.split) {
      const wantSplit = normalizeSplit(args.split)
      if (wantSplit) {
        saveConfig(normalizeConfig({ ...loadConfig(), split: wantSplit }))
        lines.push(`分流策略已改为 ${wantSplit}（${splitLabel(wantSplit)}）`)
        out.split = wantSplit
      } else {
        lines.push(`⚠ 分流档 "${args.split}" 不认，未改动（可用：直连/规则/全局，或 direct/cn-direct/all）`)
        out.ok = false
      }
    }

    // 2) 系统代理档：与分流是两个独立维度。要求代理在跑，setSysProxyMode 自己把关。
    if (args?.sysMode) {
      const m = String(args.sysMode).trim().toLowerCase()
      if (!SYS_MODES.includes(m)) {
        lines.push(`⚠ 系统代理档 "${args.sysMode}" 不认，未改动（可用 off / pac / global）`)
        out.ok = false
      } else {
        const r = await setSysProxyMode(m, { guard: args.guard, guardSec: args.guardSec, split: args.split })
        if (!r.ok) {
          lines.push(`系统代理切 ${m} 失败：${r.error || '详见返回'}`)
          out.ok = false
        } else {
          lines.push(`系统代理已切到 ${m}${r.guard ? `（守卫开着，每 ${r.guard.intervalSec} 秒巡检，漂移自动写回）` : ''}`)
          out.sysMode = r.mode
          out.snapshot = r.snapshot
        }
      }
    }

    // 2.6) DSH 自身接线：只改配置并立即接上/卸下，不重启代理进程。
    //     与 sysMode 是两个独立维度——sysMode 改注册表（系统全流量都走），
    //     wireDsh 只改 DSH 自己进程内的 dispatcher（web_fetch / 搜索 / 子进程）。
    //     代理没跑时只存配置不接线：没有监听端口可接，硬接就是把请求指向死端口。
    if (args?.wireDsh != null) {
      const wantWire = args.wireDsh === true
      const cfgWire = normalizeConfig({ ...loadConfig(), wireDsh: wantWire })
      saveConfig(cfgWire)
      if (!wantWire) {
        await unwireHostProxy({ log: wireLog })
        lines.push('DSH 自身已断开：web_fetch / 搜索 / 子进程恢复直连')
        out.wireDsh = false
      } else if (!(runtime && runtime.child && runtime.child.exitCode === null)) {
        lines.push('DSH 自身：代理没在跑，配置已存（wireDsh=true），下次启动会自动接上')
        out.wireDsh = true
      } else {
        const w = await wireIfEnabled(cfgWire, runtime.port)
        if (w.action === 'installed' || w.action === 'already') {
          lines.push(`DSH 自身已接上 ${w.proxyUrl}（来源 ${w.source}，google 走代理=${w.proxiedSelfCheck}）`)
        } else {
          lines.push(`⚠ DSH 自身接线没成（${w.action}${w.error ? '：' + w.error : ''}），保持直连；配置已存`)
          out.ok = false
        }
        out.wireDsh = true
      }
    }

    // 2.5) 订阅：先存间隔（可单独调），再拉取。sub=落盘热更，subPreview=只数不落。
    if (args?.subRefreshMin != null) {
      const c = loadConfig()
      saveConfig({ ...c, subRefreshMin: Number(args.subRefreshMin) })
      syncSubTimer()
      const now = loadConfig().subRefreshMin
      lines.push(`订阅自动刷新：${now >= 5 ? `每 ${now} 分钟` : '关'}`)
      out.subRefreshMin = now
    }
    if (args?.sub || args?.subPreview) {
      const src = typeof args.sub === 'string' ? args.sub : typeof args.subPreview === 'string' ? args.subPreview : ''
      const url = String(src || loadConfig().subUrl || '').trim()
      if (!url) {
        lines.push('⚠ 要拉订阅得给地址：sub="https://…"（落盘）或 subPreview="https://…"（只预览）')
        out.ok = false
      } else {
        const r = await applySubscription(url, { preview: !args.sub && args.subPreview === true })
        if (!r.ok) {
          lines.push(`⚠ 订阅没解析出任何节点（内容形态：${r.form}）：页面挂了、要登录、或不是链接/base64 订阅格式；节点文件未动`)
          out.ok = false
        } else if (r.preview) {
          lines.push(`订阅预览：${r.count} 条（${r.form}），例：${String(r.sample?.[0] || '').slice(0, 70)}…`)
          out.subPreview = r.count
        } else {
          const c2 = loadConfig()
          if (c2.subUrl !== url) saveConfig({ ...c2, subUrl: url })
          syncSubTimer()
          lines.push(`订阅已落地：${r.count} 条（${r.form}）→ ${r.file}；热更新 ${r.reload}${r.prev ? `；旧文件备份 ${path.basename(r.prev)}` : ''}`)
          out.sub = r.count
          out.subReload = r.reload
        }
      }
    }

    const flags = poolFlags(loadConfig(), { top: args?.top != null ? args.top : undefined })

    // 3) 守护开关
    if (args?.watch === false) {
      const r = await runSingboxNode('stop', null, { flags })
      lines.push(`守护与内核已停止（core pid ${r.stopped || '无'}，watcher pid ${r.watcher || '无'}）`)
      out.watch = false
      out.text = lines.join('\n')
      return out
    }
    if (args?.watch === true) {
      const w = await startNodeWatcher({ flags, reprobeMin: args?.reprobeMin })
      lines.push(`守护已启动（pid ${w.pid}），节点文件变更自动热更新，日志 ${path.join(w.logDir, 'node-watch.log')}`)
      out.watch = true
      out.watcherPid = w.pid
      out.text = lines.join('\n')
      return out
    }

    // 4) 热更新（只重读节点文件，不换模式，中断 0.2~0.4s）
    if (args?.reload === true) {
      const r = await runSingboxNode('reload', null, { flags })
      if (!r?.ok) {
        out.ok = false
        out.text = lines.concat(`热更新失败：${JSON.stringify(r)}`).join('\n')
        return out
      }
      lines.push(`热更新完成：${r.mode} 模式 ${r.nodes} 条，端口 ${r.port} 未变，中断 ${r.gapMs}ms（新增 ${r.added}，移除 ${r.removed}）`)
      out.reload = r
      out.text = lines.join('\n')
      return out
    }

    // 5) 核心层切换。
    // 改了 split 就必须重启核心（运行中的 sing-box 不会自己重读 --split），所以
    // 保留「默认 race 重启」的老行为；但只改 sysMode 时绝不动核心，白白中断 1 秒
    // 毫无必要——系统代理与隧道内核是两层。
    const coreUntouched = !args?.split && !args?.node && args?.race === undefined && args?.reload === undefined && args?.watch === undefined
    if (coreUntouched) {
      if (!lines.length) {
        out.ok = false
        out.text = '没有要切换的目标：给 split / sysMode / node / race / reload / watch 之一'
        return out
      }
      out.text = lines.join('\n')
      return out
    }

    const target = args?.node ? args.node : (args?.race === false ? null : 'race')
    if (!target) {
      out.ok = false
      out.text = lines.concat('没有要切换的目标：给 node / race / reload / watch 之一').join('\n')
      return out
    }
    const before = Date.now()
    await runSingboxNode('stop', null, { flags }).catch(() => {})
    const info = await runSingboxNode('start', target, { flags })
    const gap = Date.now() - before
    lines.push(
      target === 'race'
        ? `已切回竞速模式：${info.nodes} 条节点在 urltest 组里，端口 ${info.port} 未变，切换耗时 ${gap}ms`
        : `已切到节点 ${info.node} → ${info.server}（${info.kind || 'tcp'}），端口 ${info.port} 未变，切换耗时 ${gap}ms`,
    )
    out.node = target === 'race' ? 'race' : info.node
    out.gapMs = gap
    out.text = lines.join('\n')
    return out
  } catch (error) {
    out.ok = false
    out.text = lines.concat(`切换失败：${error.message}`).join('\n')
    return out
  }
}

function registerTools(ctx) {
  const tools = ctx.get('tools') || ctx.tools
  if (!tools || typeof tools.register !== 'function') return

  const register = (definition) => {
    try {
      tools.register(definition)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-local-proxy-own: tool ${definition.name} registration failed: ${error}`)
    }
  }

  register({
    name: 'local_proxy_status',
    description:
      '查看本地代理状态：是否运行、端口、上游、系统代理是否被指向 127.0.0.1、端口是否空闲、日志路径。系统代理默认不改，只有显式 start 带 systemProxy=true 才会改。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          ok: { type: 'boolean' },
          // 结构化字段：脚本与测试要能直接判状态，不该去正则解析中文文案。
          running: { type: 'boolean' },
          baselineOk: { type: 'boolean' },
          sysMode: { type: 'string', description: 'off / pac / global / foreign' },
          split: { type: 'string', description: 'direct / cn-direct / all' },
          guardOn: { type: 'boolean' },
          wired: { type: 'boolean', description: 'DSH 自身是否已接到本代理（wireDsh 装上了）' },
          wiredUrl: { type: 'string', description: '已接上的代理地址；未接为空串' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute() {
      const status = await statusSnapshot()
      return {
        ...toolResult(renderStatus(status)),
        running: Boolean(status.running),
        baselineOk: Boolean(status.baselineOk),
        sysMode: String(status.sysMode || 'off'),
        split: String(status.split || ''),
        guardOn: Boolean(status.guard),
        wired: Boolean(status.hostWired?.wired),
        wiredUrl: String(status.hostWired?.proxyUrl || ''),
      }
    },
  })

  register({
    name: 'local_proxy_start',
    description:
      '一键开启本地代理：在 127.0.0.1:<port> 起一个零依赖 SOCKS5 + HTTP 代理进程（只监听回环），并跑本机连通性自检。默认不动系统代理；systemProxy=true 时才把 HKCU Internet Settings 指到 127.0.0.1 并在关停时精确还原。上游可填 socks5:// / http:// / 留空(直连)。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number', description: `监听端口，默认 7899` },
        upstream: { type: 'string', description: 'socks5://host:port 或 http://host:port，留空=直连（填了就不再启用节点池）' },
        node: { type: 'string', description: '节点名（nodes 文件里的 tag）。填了走单节点模式；不填则按 mode 决定' },
        mode: { type: 'string', enum: ['race', 'single'], description: 'race=全部存活节点进一个 urltest 组，由内核自己竞速与亚秒切换（默认）；single=只跑一个节点' },
        split: { type: 'string', description: '分流档：直连 / 规则（国内直连，默认）/ 全局，英文同义 direct / cn-direct / all' },
        top: { type: 'number', description: '竞速模式只取探活排名前 N 条，0=全取' },
        nodes: { type: 'string', description: '节点文件路径，留空用配置里的（默认 <插件>/nodes.txt）' },
        pool: { type: 'boolean', description: '显式关掉节点池（false）时只起代理本身，不起 sing-box' },
        systemProxy: { type: 'boolean', description: '是否同时把 Windows 用户系统代理指到本代理，默认 false' },
        wireDsh: { type: 'boolean', description: '是否把 DSH 自身（web_fetch/联网工具与子进程）也接到这个本地代理上，默认 false；关停时自动卸下' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, port: { type: 'number' }, running: { type: 'boolean' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      try {
        const config = loadConfig()
        let upstream = args?.upstream
        let nodeLine = null
        // Pool is the default path: no explicit upstream and pool not disabled.
        const wantPool = !upstream && args?.pool !== false
        if (wantPool) {
          const mode = args?.node ? 'single' : (args?.mode || config.mode || 'race')
          const flags = poolFlags(config, {
            split: args?.split,
            top: args?.top != null ? args.top : undefined,
            nodes: args?.nodes,
          })
          try {
            const info = await runSingboxNode('start', mode === 'race' ? 'race' : args.node, { flags })
            upstream = `socks5://127.0.0.1:${info.port}`
            nodeLine = mode === 'race'
              ? `节点池：竞速 ${info.nodes} 条 · 分流 ${flags['--split']}（sing-box pid ${info.pid}）`
              : `节点：${info.node} → ${info.server}（sing-box pid ${info.pid}）`
          } catch (error) {
            nodeLine = `节点池未启用（${error.message}），本次按${upstream ? '指定上游' : '直连'}启动`
          }
        }
        const opts = { systemProxy: args?.systemProxy === true }
        if (args?.wireDsh != null) opts.wireDsh = args.wireDsh === true
        if (args?.port != null) opts.port = args.port
        if (upstream) opts.upstream = upstream
        if (args?.split) opts.split = normalizeSplit(args.split) || args.split
        const result = await startProxy(opts)
        const lines = [result.message || (result.already ? '代理已在运行' : '代理已启动')]
        if (nodeLine) lines.push(nodeLine)
        lines.push(`端口：127.0.0.1:${result.port ?? (await statusSnapshot()).port}`)
        lines.push(`上游：${result.upstream || 'direct'}`)
        if (result.selftest) lines.push(renderSelftest(result.selftest))
        if (result.systemProxy) lines.push(`系统代理：已写入 127.0.0.1:${result.port}（关停时按快照还原）`)
        const wireLine = wireSummaryLine(result.hostWire)
        if (wireLine) lines.push(wireLine)
        return { text: lines.join('\n'), port: Number(result.port ?? 0), running: result.ok === true }
      } catch (error) {
        return { text: `启动失败：${error.message}`, running: false }
      }
    },
  })

  register({
    name: 'local_proxy_stop',
    description:
      '一键关停本地代理：先优雅结束代理进程（stdin EOF → SIGTERM → taskkill），确认端口释放，再把系统代理按开前快照还原（原本不存在的值会被删除，而不是置空）。端口本来就空时也返回成功。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, ok: { type: 'boolean' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute() {
      let nodeNote = null
      try {
        const nodeState = await singboxStatus()
        if (nodeState?.running || nodeState?.pid) {
          const r = await runSingboxNode('stop')
          // portGone/sweptCore come from the port-based sweep in cmdStop: the
          // user's bar is "关就完全关，像没装过一样", so the note has to state
          // whether the port is actually free, not just that a pid was killed.
          const extra = Array.isArray(r.sweptCore) && r.sweptCore.length ? `，另按端口扫掉漏网核心 ${r.sweptCore.join('/')}` : ''
          const guard = r.portGone === false ? '，⚠ 端口仍被占用' : '，端口已释放'
          nodeNote = `节点进程已停止（pid ${r.stopped || nodeState.pid}${extra}）${guard}`
        }
      } catch (error) {
        nodeNote = `节点进程停止时出错：${error.message}`
      }
      const report = await stopProxy()
      const lines = [report.message]
      if (nodeNote) lines.push(nodeNote)
      for (const action of report.actions) lines.push(`- ${action}`)
      if (report.registry?.verification) {
        const current = report.registry.verification.current
        lines.push(
          `注册表现状：ProxyEnable=${current.ProxyEnable}, ProxyServer=${current.ProxyServer}, AutoConfigURL=${current.AutoConfigURL}, AutoDetect=${current.AutoDetect}, ProxyOverride=${current.ProxyOverride}`,
        )
        if (!report.registry.verification.ok) {
          lines.push(`未复位项：${report.registry.verification.problems.join('；')}`)
        }
      }
      if (report.verified) lines.push(`端口可重新监听：${report.verified.portReusable ? '是' : '否'}`)
      return { text: lines.join('\n'), ok: report.ok }
    },
  })

  register({
    name: 'local_proxy_selftest',
    description:
      '对本机代理做连通性自检：SOCKS5 握手、HTTP 代理通道、SOCKS5 通道（本机靶子），可选 external=true 额外测试外网出口（无出口时失败属正常）。返回每条检查的命令与结果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        external: { type: 'boolean', description: '是否额外测外网出口，默认 false' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, ok: { type: 'boolean' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const status = await statusSnapshot()
      if (!status.running) return { text: '代理未运行，先 local_proxy_start', ok: false }
      const result = await runSelftest(status.port, { external: args?.external === true })
      return { text: `端口 ${status.port}\n${renderSelftest(result)}`, ok: result.ok }
    },
  })

  register({
    name: 'local_proxy_nodes',
    description:
      '节点池：list=列出节点文件里能解析出的节点（含协议/UDP还是TCP/SNI）；probe=逐条真拨号竞速并排名（一条一个内核实例，并发默认 2，失败的自动串行复测一遍再判死）；rank=只看最近一次探活缓存。probe 会写缓存，start 的竞速排序按它来。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'probe', 'rank'], description: '默认 list' },
        nodes: { type: 'string', description: '节点文件路径，留空用配置里的' },
        concurrency: { type: 'number', description: 'probe 并发数，默认 2。调高会出假阴性（实测并发 3 时已知可用的节点也返回 000）' },
        top: { type: 'number', description: 'probe 结果里展示前 N 条，默认 10' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, ok: { type: 'boolean' }, alive: { type: 'number' }, total: { type: 'number' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const config = loadConfig()
      const action = args?.action || 'list'
      const flags = {}
      if (args?.nodes || config.nodes) flags['--nodes'] = args?.nodes || config.nodes
      if (args?.concurrency) flags['--concurrency'] = String(args.concurrency)
      try {
        if (action === 'probe') {
          flags['--top'] = String(args?.top || 10)
          const r = await runSingboxNode('probe', null, { flags, timeout: 900000 })
          if (!r?.ok) return { text: `探活失败：${JSON.stringify(r)}`, ok: false }
          const lines = [
            `探活完成：${r.alive}/${r.total} 存活（死 ${r.dead}，解析失败 ${r.skipped}），耗时 ${(r.elapsedMs / 1000).toFixed(1)}s，并发 ${r.concurrency || 2}`,
            `直连基线：${r.baseline?.cc || '?'} ${r.baseline?.ip || '?'}`,
            `分类：UDP ${r.byKind?.udp?.alive}/${r.byKind?.udp?.total} 存活，TCP ${r.byKind?.tcp?.alive}/${r.byKind?.tcp?.total} 存活`,
            `覆盖国家/地区：${(r.countries || []).join(' ') || '无'}`,
            `最快 ${Math.min(...(r.fastest || []).map((x) => x.ms))}ms`,
            '',
            '排名（前 ' + (r.fastest || []).length + '）：',
            ...(r.fastest || []).map((x, i) => `  ${String(i + 1).padStart(2)}. ${String(x.ms).padStart(5)}ms  ${x.tag}  [${x.kind}]  出口 ${x.egress}`),
          ]
          if ((r.deadTags || []).length) lines.push('', `判死：${r.deadTags.join('、')}`)
          if (r.retried) lines.push(`失败串行复测 ${r.retried} 条，救回 ${r.recoveredOnRetry} 条`)
          return { text: lines.join('\n'), ok: true, alive: r.alive, total: r.total }
        }
        if (action === 'rank') {
          const r = await runSingboxNode('list', null, { flags })
          const ranked = (r.nodes || []).filter((n) => n.rank)
          const lines = [
            `节点文件：${r.file}`,
            `可解析 ${r.total} 条，解析失败 ${r.skipped} 条`,
            r.probeAgeMs != null ? `探活缓存：${Math.round(r.probeAgeMs / 60000)} 分钟前，已排名 ${ranked.length} 条` : '探活缓存：无（先 action=probe）',
            '',
            ...(ranked.length
              ? ranked.sort((a, b) => a.rank - b.rank).slice(0, args?.top || 15)
                .map((n) => `  ${String(n.rank).padStart(2)}. ${String(n.ms).padStart(5)}ms  ${n.tag}  [${n.kind}/${n.transport}]  ${n.server}:${n.port}  sni=${n.sni || '-'}`)
              : ['  （无排名数据）']),
          ]
          return { text: lines.join('\n'), ok: true, total: r.total, alive: ranked.length }
        }
        const r = await runSingboxNode('list', null, { flags })
        const byKind = {}
        for (const n of r.nodes || []) byKind[n.kind] = (byKind[n.kind] || 0) + 1
        const lines = [
          `节点文件：${r.file}`,
          `可解析 ${r.total} 条（${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join('，')}），解析失败 ${r.skipped} 条`,
          '',
          ...(r.nodes || []).slice(0, args?.top || 60).map((n, i) =>
            `  ${String(i + 1).padStart(2)}. ${n.tag}  [${n.kind}/${n.transport}]  ${n.server}:${n.port}  sni=${n.sni || '-'}`),
        ]
        if (r.skippedDetail?.length) lines.push('', '解析失败样例：', ...r.skippedDetail.map((s) => `  ${s.line} → ${s.error}`))
        return { text: lines.join('\n'), ok: true, total: r.total, alive: 0 }
      } catch (error) {
        return { text: `节点池操作失败：${error.message}`, ok: false }
      }
    },
  })

  register({
    name: 'local_proxy_switch',
    description:
      '运行时换线路，监听端口不变（18999），所以上层代理与系统代理都不用动：node=切到某个指定节点；race=切回全节点竞速；reload=重读节点文件热更新（实测间隔约 0.2-0.4s）；split=改分流策略（cn-direct 国内直连 / all 全走隧道 / direct 全直连）；watch=true 开守护（节点文件一变就自动 reload，可选每 N 分钟重探活），watch=false 关守护。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', description: '切到指定节点 tag（走单节点模式）' },
        race: { type: 'boolean', description: 'true=切回竞速模式（全部存活节点进 urltest 组，内核自己亚秒切换）' },
        reload: { type: 'boolean', description: 'true=只重读节点文件热更新，不换模式' },
        split: { type: 'string', description: '改分流档并写回配置：直连 / 规则 / 全局，或 direct / cn-direct / all' },
        top: { type: 'number', description: '竞速模式只取前 N 条' },
        watch: { type: 'boolean', description: '开/关节点文件守护' },
        reprobeMin: { type: 'number', description: '守护下每 N 分钟重新探活一次，0=不自动探活' },
        sysMode: { type: 'string', enum: ['off', 'pac', 'global'], description: '系统代理档（与分流档是两个独立维度）：off=关闭并还原到开前状态，pac=PAC 分流，global=全部流量进代理' },
        guard: { type: 'boolean', description: '配 sysMode 用：是否开守卫，默认 true' },
        guardSec: { type: 'number', description: '守卫巡检间隔秒，默认 30，最小 10' },
        sub: { type: 'string', description: '订阅：拉取该 URL（或裸 true 用已存地址语义由面板负责，工具请给 URL）并落盘热更 nodes.txt；解析 0 条绝不动旧文件' },
        subPreview: { type: 'string', description: '只解析计数不落盘（试订阅链接用）；不给则用配置里已存的 subUrl' },
        subRefreshMin: { type: 'number', description: '订阅自动刷新间隔分钟（0=关，最小生效 5）；定时器在 host 侧，关栈时照常把节点文件保持新鲜' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, ok: { type: 'boolean' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      // 与面板的 /switch 路由共用同一份实现——分两份写，迟早出现「工具说成功、
      // 面板显示另一套」的漂移。
      const r = await applySwitch(args)
      return { text: r.text, ok: r.ok }
    },
  })

  register({
    name: 'local_proxy_pac',
    description:
      '生成 PAC 分流文件（国内域名与内网直连、其余走本地代理），供浏览器或单个程序指定使用。不改 Windows 全局代理，不建 TUN 网卡；域名列表内置，运行时不联网取规则。返回文件路径与 file:/// URL。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number', description: 'PAC 里写的代理端口，默认用当前代理端口' },
        split: { type: 'string', description: '生成 PAC 用的分流档：直连 / 规则（默认）/ 全局' },
        out: { type: 'string', description: '输出路径，默认 <插件>/.runtime/proxy.pac' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, ok: { type: 'boolean' }, file: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const config = loadConfig()
      const status = await statusSnapshot()
      const nodePath = resolveRuntimeNode()
      if (!nodePath) return { text: '找不到可用的 node 运行时', ok: false }
      const argv = [path.join(PLUGIN_ROOT, 'bin', 'pac.js'),
        '--port', String(args?.port || status.port || config.port),
        '--split', normalizeSplit(args?.split) || config.split || 'cn-direct']
      if (args?.out) argv.push('--out', args.out)
      try {
        const { stdout } = await execFileAsync(nodePath, argv, {
          cwd: PLUGIN_ROOT,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          timeout: 20000,
        })
        const r = JSON.parse(String(stdout).trim())
        return {
          text: [
            `PAC 已生成：${r.file}`,
            `URL：${r.url}`,
            `代理：${r.host}:${r.port}　策略：${r.mode}　体积：${r.bytes} B`,
            '用法：浏览器/程序里把自动配置脚本指到上面这个 URL；只影响指定它的程序，不动系统全局代理。',
          ].join('\n'),
          ok: true,
          file: r.file,
        }
      } catch (error) {
        return { text: `PAC 生成失败：${error.message}`, ok: false }
      }
    },
  })

  register({
    name: 'local_proxy_sysproxy',
    description:
      '系统代理三档一键切换：off=关闭并按快照还原到开前状态；pac=系统级 PAC 分流（国内与内网直连、只有国外走代理，日常推荐）；global=系统全部流量进本地代理（再由分流规则决定走不走隧道）。开 pac/global 默认同时开守卫：每 30 秒核对注册表，被 Windows 自动检测、其它 VPN 客户端或组策略改回去就写回并留痕；代理进程一消失守卫自动还原注册表并停摆，绝不让系统代理指向死端口。不传 mode 只报当前档位。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['off', 'pac', 'global'], description: '目标档位；不传则只报当前状态不做改动' },
        guard: { type: 'boolean', description: '是否开守卫，默认 true（仅 pac/global 有效）' },
        guardSec: { type: 'number', description: '守卫巡检间隔秒，默认 30，最小 10' },
        split: { type: 'string', description: '生成 PAC 用的分流档：直连/规则/全局 或 direct/cn-direct/all，默认读配置' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          ok: { type: 'boolean' },
          mode: { type: 'string', description: 'off / pac / global / foreign' },
          snapshot: { type: 'string', description: 'captured=首次采集基线；reused=复用已有基线（pac↔global 互切必须是 reused）' },
          port: { type: 'number' },
          pacUrl: { type: 'string' },
          guardOn: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      if (!args?.mode) {
        const values = await regQueryAll()
        const mode = sysModeFromRegistry(values)
        const lines = [
          `系统代理当前档位：${mode}`,
          `  ProxyEnable = ${values.ProxyEnable ? values.ProxyEnable.data : '(不存在)'}`,
          `  ProxyServer = ${values.ProxyServer ? values.ProxyServer.data : '(不存在)'}`,
          `  AutoConfigURL = ${values.AutoConfigURL ? values.AutoConfigURL.data : '(不存在)'}`,
        ]
        if (sysGuard) {
          lines.push(`守卫：开着（档 ${sysGuard.mode}，每 ${sysGuard.intervalSec} 秒，已巡 ${sysGuard.checks} 次，写回 ${sysGuard.repairs.length} 次）`)
          if (sysGuard.lastDrift) lines.push(`  最近漂移：${sysGuard.lastDrift.join('；')}`)
        } else {
          lines.push('守卫：未开')
        }
        if (mode === 'foreign') lines.push('⚠ 系统代理开着但不是指向我们（别的软件设的），本插件不会去动它。')
        lines.push('切换：mode=off / pac / global。日常推荐 pac：国内直连不损速度，国外自动走代理。')
        return { text: lines.join('\n'), ok: true, mode, guardOn: Boolean(sysGuard) }
      }

      const mode = String(args.mode).trim().toLowerCase()
      if (!SYS_MODES.includes(mode)) return { text: `未知档位：${args.mode}（可用 off / pac / global）`, ok: false }

      const r = await setSysProxyMode(mode, { guard: args.guard, guardSec: args.guardSec, split: args.split })
      if (!r.ok) {
        // additionalProperties:false 且字段都声明了具体类型，没值的字段不要塞
        // null 进去，省掉键就行——否则宿主按 schema 校验会判失败。
        const bad = {
          text: `系统代理切 ${mode} 失败：${r.error || (r.problems || []).join('；') || JSON.stringify(r).slice(0, 300)}`,
          ok: false,
        }
        if (r.mode) bad.mode = r.mode
        return bad
      }

      const lines = [`系统代理已切到：${mode}`]
      if (mode === 'pac') {
        lines.push(`PAC：${r.pacUrl}（${r.pacBytes} B）`)
        lines.push('效果：国内域名与内网直连、其余走本地代理；只对尊重系统代理/PAC 的程序生效。')
      } else if (mode === 'global') {
        lines.push(`ProxyServer：127.0.0.1:${r.port}`)
        lines.push('效果：尊重系统代理的程序全部流量进本地代理，再由分流规则决定走不走隧道。')
      } else {
        lines.push(`还原方式：${r.restored?.method || 'snapshot'}；还原 ${r.restored?.restored?.length || 0} 项、删除 ${r.restored?.deleted?.length || 0} 项`)
        if (r.guardStopped) lines.push(`守卫已停（共巡 ${r.guardStopped.checks} 次、写回 ${r.guardStopped.repairs} 次）`)
      }
      if (r.guard) lines.push(`守卫：开着，每 ${r.guard.intervalSec} 秒巡检，漂移自动写回`)
      if (r.snapshot) lines.push(`基线快照：${r.snapshot}（${r.snapshotPath}）`)
      if (r.problems && r.problems.length) lines.push(`⚠ 注册表校验：${r.problems.join('；')}`)
      const out = { text: lines.join('\n'), ok: true, mode: r.mode, guardOn: Boolean(r.guard) }
      if (r.snapshot) out.snapshot = r.snapshot
      if (r.port) out.port = r.port
      if (r.pacUrl) out.pacUrl = r.pacUrl
      return out
    },
  })
}

// --- plugin ------------------------------------------------------------------

export function apply(ctx) {
  hostCtx = ctx
  registerTools(ctx)

  // 清扫记进模块 promise：startProxy 开头会等它收尾再起新代理（根治「清扫杀新
  // 进程」竞态）。下面 .then 只是把结果写日志，不改变时序。
  reconcileInFlight = reconcileOnLoad()
  reconcileInFlight
    .then((result) => {
      // swept = 已清掉上次会话的遗留进程。正常退出后这里应该是「无遗留」；
      // 有遗留说明上次宿主是异常死的（崩溃 / 被 taskkill / 断电），钩子没跑成。
      if (result.action === 'swept') {
        const s = result.survivors || {}
        const leftover = [
          s.watcher?.pid && `watcher ${s.watcher.pid}`,
          s.core?.pid && `core ${s.core.pid}`,
          s.proxy?.pid && `proxy ${s.proxy.pid}`,
        ].filter(Boolean)
        ctx.logger?.info?.(
          `dsh-local-proxy-own: startup sweep ${leftover.length ? `清掉遗留 ${leftover.join('、')}` : '无遗留'}` +
            (result.autoStart ? '（autoStart 已开）' : ''),
        )
      }
    })
    .catch((error) => {
      ctx.logger?.warn?.(`dsh-local-proxy-own: startup reconcile failed: ${error}`)
    })

  // wireDsh 开时把接线补回来：dispatcher 活在进程内，宿主一重启就没了。不补就是
  // 「代理在跑但 DSH 不走」的静默半态——面板看着一切正常，web_fetch 其实还是直连。
  ;(async () => {
    try {
      const cfg = loadConfig()
      if (!cfg.wireDsh) return
      await reconcileInFlight
      const snap = await statusSnapshot()
      if (snap.running) {
        const r = await wireIfEnabled(cfg, snap.port)
        ctx.logger?.info?.(`dsh-local-proxy-own: 开机接线 ${r.action}${r.proxyUrl ? ` → ${r.proxyUrl}` : ''}`)
      } else {
        wireLog('开机：代理未在跑，跳过接线')
      }
    } catch (error) {
      wireLog(`开机接线失败（直连不受影响）：${error?.message ?? error}`)
    }
  })()

  const registerRoutes = (webServer, fiber) => {
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET' && req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            sendJson(res, 200, await statusSnapshot())
          } catch (error) {
            sendJson(res, 500, { ok: false, code: 'internal', error: String(error.message || error) })
          }
        },
      }),
    )

    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/start`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
            return
          }
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch {
            sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
            return
          }
          try {
            const result = await startProxy({
              port: body.port,
              upstream: body.upstream,
              systemProxy: body.systemProxy === true,
            })
            sendJson(res, 200, { ...result, status: await statusSnapshot() })
          } catch (error) {
            sendJson(res, 400, { ok: false, code: 'start-failed', error: String(error.message || error) })
          }
        },
      }),
    )

    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/stop`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
            return
          }
          try {
            const report = await stopProxy()
            sendJson(res, 200, { ...report, status: await statusSnapshot() })
          } catch (error) {
            sendJson(res, 500, { ok: false, code: 'stop-failed', error: String(error.message || error) })
          }
        },
      }),
    )

    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/selftest`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST' && req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
            return
          }
          let body = {}
          try {
            body = req.method === 'POST' ? await readJsonBody(req) : {}
          } catch {
            body = {}
          }
          const status = await statusSnapshot()
          if (!status.running) {
            sendJson(res, 409, { ok: false, code: 'not-running', error: 'proxy is not running' })
            return
          }
          try {
            sendJson(res, 200, await runSelftest(status.port, { external: body.external === true }))
          } catch (error) {
            sendJson(res, 500, { ok: false, code: 'internal', error: String(error.message || error) })
          }
        },
      }),
    )

    // --- 面板路由：节点列表 / 出口实测 / 模式切换 ---
    // 路由只负责鉴权、参数解析与 HTTP 语义；业务逻辑全在共享函数里，这样面板
    // 显示的与工具做的是同一件事，不会出现两套行为。

    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/nodes`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            const config = loadConfig()
            let watchPid = null
            try {
              watchPid = Number(String(fs.readFileSync(path.join(RUNTIME_DIR, 'watch.pid'), 'utf8')).trim()) || null
            } catch {}
            // 两个 state 文件含义不同，别搞混：
            //   state.json          = proxy.js（127.0.0.1:17899，本插件自己的收口进程）
            //   singbox-state.json  = sing-box 内核（18999，含 race/single 模式与当前节点）
            let coreState = null
            try {
              coreState = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'singbox-state.json'), 'utf8'))
            } catch {}
            sendJson(res, 200, {
              ok: true,
              probe: readProbeCache(),
              mode: coreState?.mode || config.mode || 'race',
              node: coreState?.node || null,
              coreNodes: coreState?.nodes ?? null,
              split: config.split,
              splitLabel: splitLabel(config.split),
              top: config.top ?? 0,
              reprobeMin: config.reprobeMin ?? 0,
              nodesFile: config.nodes || path.join(PLUGIN_ROOT, 'nodes.txt'),
              // 守护状态只认「进程还活着」：pid 文件在而进程没了，算没开。
              watcher: watchPid ? { pid: watchPid, alive: processAlive(watchPid) } : null,
              core: coreState
                ? { pid: coreState.pid, alive: processAlive(coreState.pid), port: coreState.port, mode: coreState.mode || 'single', node: coreState.node || null }
                : null,
            })
          } catch (error) {
            sendJson(res, 500, { ok: false, code: 'internal', error: String(error.message || error) })
          }
        },
      }),
    )

    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/egress`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET' && req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET/POST only' })
            return
          }
          try {
            const status = await statusSnapshot()
            if (!status.running) {
              sendJson(res, 409, { ok: false, code: 'not-running', error: '代理没在运行，测不了出口' })
              return
            }
            // 1~3 秒真实网络往返，所以只按请求测，绝不进 2.5s 轮询
            sendJson(res, 200, await measureEgress(status.port))
          } catch (error) {
            sendJson(res, 500, { ok: false, code: 'internal', error: String(error.message || error) })
          }
        },
      }),
    )

    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/switch`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
            return
          }
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch {
            sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
            return
          }
          try {
            const r = await applySwitch(body)
            // 附带最新 status：面板一次往返就能刷新，不用再拉一次
            sendJson(res, r.ok ? 200 : 400, { ...r, status: await statusSnapshot() })
          } catch (error) {
            sendJson(res, 500, { ok: false, code: 'switch-failed', error: String(error.message || error) })
          }
        },
      }),
    )

    // --- 订阅（Group 5）：GET 状态，POST 拉取（apply 才落盘热更） ---
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/sub`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          const config = loadConfig()
          if (req.method === 'GET') {
            sendJson(res, 200, {
              ok: true,
              subUrl: config.subUrl || '',
              subRefreshMin: config.subRefreshMin || 0,
              last: lastSubFetch,
            })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET/POST only' })
            return
          }
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch {
            sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
            return
          }
          // refreshMin persists even without a fetch (0 = auto off).
          if (body.refreshMin != null) {
            try {
              saveConfig({ ...config, subRefreshMin: Number(body.refreshMin) })
              syncSubTimer()
            } catch (e) {
              sendJson(res, 400, { ok: false, code: 'bad-refresh', error: String(e.message || e) })
              return
            }
          }
          const url = String(body.url || config.subUrl || '').trim()
          if (!url) {
            // A refresh-interval-only change is a complete, valid request.
            if (body.refreshMin != null) {
              sendJson(res, 200, { ok: true, subRefreshMin: loadConfig().subRefreshMin })
              return
            }
            sendJson(res, 400, { ok: false, code: 'no-url', error: '没有订阅地址：填一个，或先设置自动刷新的间隔' })
            return
          }
          try {
            const r = await applySubscription(url, { preview: body.apply !== true })
            if (!r.ok) {
              sendJson(res, 400, { ...r, error: '订阅里没解析出任何节点链接（页面可能挂了或不是订阅格式）', subUrl: url }) }
            else if (r.preview) sendJson(res, 200, r)
            else {
              // Only a landed fetch stores the URL - a dead one must not
              // poison the timer.
              const c2 = loadConfig()
              if (c2.subUrl !== url) saveConfig({ ...c2, subUrl: url })
              syncSubTimer()
              sendJson(res, 200, { ...r, subUrl: url, subRefreshMin: loadConfig().subRefreshMin })
            }
          } catch (error) {
            sendJson(res, 400, { ok: false, code: 'sub-failed', error: String(error.message || error) })
          }
        },
      }),
    )

    // --- 后台重新探活：POST 起飞（不阻塞），GET 看是否在跑 ---
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/reprobe`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, ...reprobeState() })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET/POST only' })
            return
          }
          try {
            sendJson(res, 200, { ok: true, ...startBackgroundReprobe() })
          } catch (error) {
            sendJson(res, 500, { ok: false, code: 'reprobe-failed', error: String(error.message || error) })
          }
        },
      }),
    )
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoutes(webServer, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
  }

  // Subscription timer: armed from the saved config at boot, re-armed by
  // every write path, disposed on fiber teardown (reload/close) so a plugin
  // reload never leaves a stray interval behind.
  ctx.effect(() => {
    syncSubTimer()
    return () => {
      if (subTimer) {
        clearInterval(subTimer)
        subTimer = null
      }
    }
  })

  // A plugin reload must not leave a stray listener behind.
  ctx.effect(() => () => {
    if (runtime && runtime.child) {
      try {
        runtime.child.kill()
      } catch {}
    }
  })
}

// Test surface: pure helpers only, no state, no side effects. Used by
// scripts/subscription-test.mjs; harmless in the host (cordis ignores extra exports).
export const __test = { parseSubscription, normalizeConfig, poolFlags, nodesFilePath, DEFAULT_CONFIG }
