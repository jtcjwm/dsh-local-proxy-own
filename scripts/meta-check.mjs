// meta-check.mjs - 按宿主 dsh-app-boot 的 readPluginMeta 算法复刻一遍插件元数据解析，
// 在重启前就预测「设置 → 插件」列表里会显示什么标题、什么图标。
//
//   node scripts/meta-check.mjs            # 校验本包
//   node scripts/meta-check.mjs <pkgName>  # 校验别的包（需能从当前目录解析）
//
// 复刻的宿主契约（dsh-app-boot/lib/index.js，2026-10-21 读自 v24.21.0 宿主）：
//   LANGUAGE_ID    = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/
//   MAX_ICON_BYTES = 256 * 1024
//   ICON_MEDIA_TYPES = .svg/.png/.jpg/.jpeg/.webp
//   · 先解析 `${specifier}/locale/en.json`；解析不到 ⇒ 词典为空 ⇒ title 回落 manifest.name
//   · 再读 en.json 同目录下所有 .json，文件名必须是合法语言 id，且都要能通过
//     `${specifier}/locale/<name>` 解析（⇒ exports 必须放行 ./locale/*.json）
//   · 结构固定 { meta: { title, description } }，title/description 必须是非空字符串
//   · icon 取 manifest.icon（相对路径、留在 manifest 目录内）或导出的 `<specifier>/icon`
//   · 任一环节抛错 ⇒ 整份元数据变成 { error }，列表里显示诊断而不是标题
import { realpathSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
const MAX_ICON_BYTES = 256 * 1024
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

const specifier = process.argv[2] || (await readPackageSelfName())
async function readPackageSelfName() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).name
}

let bad = 0
const fail = (m) => { bad++; console.log(`  ✗ ${m}`) }
const ok = (m) => console.log(`  ✓ ${m}`)

console.log(`specifier = ${specifier}`)

// --- manifest（仅当 specifier 就是包名时宿主才读它）---
let manifest, manifestPath
try {
  manifestPath = fileURLToPath(import.meta.resolve(`${specifier}/package.json`))
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  ok(`package.json 可解析：${manifestPath}`)
} catch (e) {
  fail(`package.json 解析失败：${e.message.split('\n')[0]}`)
}

// --- locale 词典 ---
const dictionaries = new Map()
let englishPath
try {
  englishPath = fileURLToPath(import.meta.resolve(`${specifier}/locale/en.json`))
  ok(`locale/en.json 可解析：${englishPath}`)
} catch {
  englishPath = undefined
  console.log('  ! locale/en.json 解析不到 ⇒ 宿主把词典置空，标题将回落到 manifest.name')
}

if (englishPath) {
  const dir = path.dirname(englishPath)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    const language = entry.name.slice(0, -5)
    const resource = `${specifier}/locale/${entry.name}`
    if (!LANGUAGE_ID.test(language)) { fail(`${resource} 的文件名不是合法语言 id`); continue }
    const id = language.toLowerCase()
    if (dictionaries.has(id)) { fail(`${resource} 与已有语言 ${id} 重复`); continue }
    let file
    try {
      file = fileURLToPath(import.meta.resolve(resource))
    } catch (e) {
      fail(`${resource} 解析失败（exports 是否放行 ./locale/*.json？）：${e.message.split('\n')[0]}`)
      continue
    }
    if (path.dirname(file) !== dir) { fail(`${resource} 未与 en.json 同目录：${file}`); continue }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      fail(`${file} 不是合法 JSON：${e.message.split('\n')[0]}`)
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { fail(`${file} 顶层必须是对象`); continue }
    const meta = parsed.meta
    if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) { fail(`${file}: meta 必须是对象`); continue }
    const pick = (v, p) => {
      if (v === undefined) return undefined
      if (typeof v !== 'string' || v.trim() === '') throw new Error(`${p} 必须是非空字符串`)
      return v
    }
    try {
      dictionaries.set(id, {
        title: pick(meta?.title, `${file}: meta.title`),
        description: pick(meta?.description, `${file}: meta.description`),
      })
      ok(`locale/${entry.name} → 语言 ${id}，title=${JSON.stringify(meta?.title)}`)
    } catch (e) {
      fail(e.message)
    }
  }
}

// --- localizedText：宿主最终会渲染的标题 ---
function localizedText(field, fallback, finalFallback) {
  const entries = [...dictionaries].flatMap(([language, fields]) => {
    const value = fields[field]
    return value === undefined ? [] : [[language, value]]
  })
  if (entries.length === 0) return fallback
  return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) }
}
const title = localizedText('title', manifest?.name?.trim() ? manifest.name : undefined, specifier)
const description = localizedText('description', manifest?.description?.trim() ? manifest.description : undefined, '')
console.log('  ── 宿主将渲染的标题 ──')
if (title === undefined) console.log('    （无词典且 manifest.name 为空 ⇒ 回落成 specifier 本身）')
else if (typeof title === 'string') console.log(`    回落（无词典）：${title}`)
else for (const [lang, text] of Object.entries(title)) console.log(`    ${lang}: ${text}`)
console.log('  ── 宿主将渲染的描述 ──')
if (description === undefined) console.log('    （无）')
else if (typeof description === 'string') console.log(`    回落：${description.slice(0, 60)}…`)
else for (const [lang, text] of Object.entries(description)) console.log(`    ${lang}: ${String(text).slice(0, 60)}…`)

// --- iconOf ---
function iconOf(value) {
  let target, label
  if (manifestPath !== undefined && value !== undefined) {
    const icon = typeof value === 'string' && value.trim() !== '' ? value : undefined
    if (icon === undefined) throw new Error(`${manifestPath}: icon 必须是非空字符串`)
    if (path.isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) throw new Error(`${manifestPath}: icon 必须是相对路径`)
    label = manifestPath
    const root = realpathSync(path.dirname(manifestPath))
    target = path.resolve(root, icon)
    const local = path.relative(root, realpathSync(target))
    if (local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)) throw new Error(`${label}: icon 必须留在 manifest 目录内`)
  } else {
    const exported = import.meta.resolve(`${specifier}/icon`)
    target = label = fileURLToPath(exported)
  }
  const mediaType = ICON_MEDIA_TYPES.get(path.extname(target).toLowerCase())
  if (mediaType === undefined) throw new Error(`${label}: icon 必须是 SVG/PNG/JPEG/WebP`)
  const st = statSync(target)
  if (!st.isFile()) throw new Error(`${label}: icon 必须是常规文件`)
  if (st.size > MAX_ICON_BYTES) throw new Error(`${label}: icon 超出 256 KiB（${st.size}）`)
  const bytes = readFileSync(target)
  return { url: `data:${mediaType};base64,${bytes.toString('base64')}`, size: st.size, mediaType, target }
}
try {
  const r = iconOf(manifest?.icon)
  ok(`icon → ${r.mediaType}，源文件 ${r.size} B（≤ ${MAX_ICON_BYTES}），data URL ${r.url.length} 字符`)
  console.log(`    ${r.target}`)
  console.log(`    ${r.url.slice(0, 48)}…`)
} catch (e) {
  fail(`icon：${e.message}`)
}

console.log(bad ? `\n结果：${bad} 项不通过 —— 宿主会把整份元数据降级成 error 诊断` : '\n结果：全部通过，重启后列表应显示上面的标题与图标')
process.exit(bad ? 1 : 0)
