// node-parse.js - shared node URI parsing for dsh-local-proxy-own.
//
// Zero dependencies. Turns share-link URIs into sing-box outbound objects.
// Supported: vless:// (incl. reality+vision), vmess:// (tcp/ws/http/h2/grpc),
//            hysteria2:// + hy2://, tuic://
//
// Extracted out of singbox-node.js so the prober and the runner share ONE
// definition of "what a node is" — a divergence here means the prober tests
// something the runner never dials.
import fs from 'node:fs'
import path from 'node:path'

export function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes'
}

function splitUri(uri, schemeLen) {
  const body = uri.slice(schemeLen)
  const hashAt = body.lastIndexOf('#')
  const tag = hashAt >= 0 ? decodeURIComponent(body.slice(hashAt + 1)) : ''
  const core = hashAt >= 0 ? body.slice(0, hashAt) : body
  const qAt = core.indexOf('?')
  const authority = qAt >= 0 ? core.slice(0, qAt) : core
  const query = qAt >= 0 ? core.slice(qAt + 1) : ''
  return { tag, authority, query: new URLSearchParams(query) }
}

function splitHostPort(hp) {
  const clean = hp.replace(/\/$/, '')
  const colon = clean.lastIndexOf(':')
  if (colon < 0) throw new Error('bad host:port')
  return { server: clean.slice(0, colon), server_port: parseInt(clean.slice(colon + 1), 10) }
}

export function parseVmess(uri) {
  const body = uri.slice('vmess://'.length)
  const hashAt = body.lastIndexOf('#')
  const tagOverride = hashAt >= 0 ? decodeURIComponent(body.slice(hashAt + 1)) : ''
  const b64 = hashAt >= 0 ? body.slice(0, hashAt) : body
  let j
  try {
    j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
  } catch {
    throw new Error('bad vmess base64 json')
  }
  const server = j.add || j.addr
  const port = parseInt(j.port, 10)
  const uuid = j.id
  if (!server || !port || !uuid) throw new Error('vmess missing add/port/id')
  const out = {
    type: 'vmess',
    tag: tagOverride || j.ps || `${server}:${port}`,
    server,
    server_port: port,
    uuid,
    security: j.scy || 'auto',
    alter_id: parseInt(j.aid || '0', 10),
    global_padding: false,
  }
  const net = (j.net || 'tcp').toLowerCase()
  if (net === 'ws' || net === 'http' || net === 'h2' || net === 'grpc') {
    out.transport = { type: net === 'h2' ? 'http' : net }
    if (j.path) out.transport.path = j.path
    const host = j.host || (j.headers && j.headers.Host)
    if (host) {
      if (net === 'ws') {
        out.transport.headers = { Host: Array.isArray(host) ? host[0] : host }
      } else if (net === 'http' || net === 'h2') {
        // sing-box http transport wants an array; dropping the vhost makes the
        // server refuse the request even though the TLS handshake succeeded.
        out.transport.host = Array.isArray(host) ? host : [host]
      }
    }
    if (j.serviceName) out.transport.service_name = j.serviceName
  }
  if (j.tls === 'tls' || j.tls === 'xtls' || j.sni) {
    out.tls = {
      enabled: true,
      server_name: j.sni || j.tlsServerName || undefined,
      alpn: j.alpn ? String(j.alpn).split(',') : undefined,
      insecure: truthy(j.allowInsecure) || undefined,
    }
    if (j.fp) out.tls.utls = { enabled: true, fingerprint: j.fp }
  }
  return out
}

export function parseVless(uri) {
  const { tag, authority, query: q } = splitUri(uri, 'vless://'.length)
  const at = authority.lastIndexOf('@')
  if (at < 0) throw new Error('no uuid@host')
  const uuid = authority.slice(0, at)
  const { server, server_port } = splitHostPort(authority.slice(at + 1))
  const tls = {
    enabled: true,
    server_name: q.get('sni') || undefined,
    alpn: q.get('alpn') ? q.get('alpn').split(',') : undefined,
    utls: q.get('fp') ? { enabled: true, fingerprint: q.get('fp') } : undefined,
  }
  if (q.get('security') === 'reality') {
    tls.reality = {
      enabled: true,
      public_key: q.get('pbk') || undefined,
      short_id: q.get('sid') || undefined,
    }
  }
  const out = { type: 'vless', tag: tag || `${server}:${server_port}`, server, server_port, uuid, tls }
  if (q.get('flow')) out.flow = q.get('flow')
  const type = q.get('type')
  if (type && type !== 'tcp') {
    out.transport = { type }
    if (q.get('path')) out.transport.path = q.get('path')
    if (q.get('host')) out.transport.headers = { Host: q.get('host') }
    if (q.get('serviceName')) out.transport.service_name = q.get('serviceName')
  }
  return out
}

// hysteria2://[user:]password@host:port/?insecure=1&sni=X&alpn=h3&obfs=salamander&obfs-password=P#tag
// When the URI carries `user:password`, sing-box wants the WHOLE string as
// `password` — stripping the user part yields `503 authentication failed`.
export function parseHysteria2(uri) {
  const schemeLen = uri.startsWith('hy2://') ? 'hy2://'.length : 'hysteria2://'.length
  const { tag, authority, query: q } = splitUri(uri, schemeLen)
  const at = authority.lastIndexOf('@')
  if (at < 0) throw new Error('hysteria2: no password@host')
  const password = decodeURIComponent(authority.slice(0, at))
  if (!password) throw new Error('hysteria2: empty password')
  const { server, server_port } = splitHostPort(authority.slice(at + 1))
  if (!server || !server_port) throw new Error('hysteria2: bad host:port')
  const tls = {
    enabled: true,
    server_name: q.get('sni') || q.get('peer') || undefined,
    alpn: q.get('alpn') ? q.get('alpn').split(',') : ['h3'],
    insecure: truthy(q.get('insecure') || q.get('allowInsecure')) || undefined,
  }
  const out = { type: 'hysteria2', tag: tag || `${server}:${server_port}`, server, server_port, password, tls }
  const obfs = q.get('obfs')
  if (obfs && obfs !== 'none') out.obfs = { type: obfs, password: q.get('obfs-password') || undefined }
  // sing-box has no pinSHA256 knob; insecure is what actually gets us through.
  if ((q.get('pinSHA256') || q.get('sha256')) && !out.tls.insecure) out.tls.insecure = true
  return out
}

// tuic://uuid:password@host:port/?sni=X&alpn=h3&disable_sni=true#tag
export function parseTuic(uri) {
  const { tag, authority, query: q } = splitUri(uri, 'tuic://'.length)
  const at = authority.lastIndexOf('@')
  if (at < 0) throw new Error('tuic: no uuid:password@host')
  const cred = authority.slice(0, at)
  const cAt = cred.indexOf(':')
  const uuid = cAt >= 0 ? cred.slice(0, cAt) : cred
  const password = cAt >= 0 ? cred.slice(cAt + 1) : ''
  const { server, server_port } = splitHostPort(authority.slice(at + 1))
  const out = {
    type: 'tuic',
    tag: tag || `${server}:${server_port}`,
    server,
    server_port,
    uuid,
    password: password || undefined,
    tls: {
      enabled: true,
      server_name: q.get('sni') || undefined,
      alpn: q.get('alpn') ? q.get('alpn').split(',') : ['h3'],
      insecure: truthy(q.get('allow-insecure') || q.get('insecure')) || undefined,
      disable_sni: truthy(q.get('disable_sni')) || undefined,
    },
  }
  if (q.get('congestion_control')) out.congestion_control = q.get('congestion_control')
  return out
}

export const PARSERS = [
  ['vless://', parseVless],
  ['vmess://', parseVmess],
  ['hysteria2://', parseHysteria2],
  ['hy2://', parseHysteria2],
  ['tuic://', parseTuic],
]

// Returns { nodes, skipped, file } so callers can tell "file empty" from
// "every line malformed" — the difference matters when a subscription rots.
export function readNodes(file) {
  if (!file) throw new Error('readNodes: no file')
  if (!fs.existsSync(file)) throw new Error(`nodes file not found: ${file}`)
  const nodes = []
  const skipped = []
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    let hit = false
    for (const [prefix, fn] of PARSERS) {
      if (!line.startsWith(prefix)) continue
      hit = true
      try {
        nodes.push(fn(line))
      } catch (e) {
        skipped.push({ line: line.slice(0, 60), error: String(e.message || e) })
      }
      break
    }
    if (!hit) skipped.push({ line: line.slice(0, 60), error: 'unknown scheme' })
  }
  return { nodes, skipped, file }
}

// UDP (QUIC) and TCP fail independently: a node dead on TCP may still work on
// UDP and vice versa. Keep the distinction visible in every report.
export function describe(n) {
  const kind = n.type === 'hysteria2' || n.type === 'tuic' ? 'udp' : 'tcp'
  const transport = n.transport ? n.transport.type : (kind === 'udp' ? n.type : 'tcp')
  return {
    tag: n.tag,
    type: n.type,
    kind,
    transport,
    server: n.server,
    port: n.server_port,
    sni: (n.tls && n.tls.server_name) || null,
  }
}

export function resolveNodesFile(explicit, pkgDir) {
  return path.resolve(explicit || process.env.DSH_LOCAL_PROXY_NODES || path.join(pkgDir, 'nodes.txt'))
}
