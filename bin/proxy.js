// dsh-local-proxy-own - standalone loopback proxy process.
//
// One TCP listener speaks two protocols by sniffing the first byte:
//   * 0x05  -> SOCKS5 (RFC 1928, CONNECT only, no auth)
//   * ASCII -> HTTP proxy (CONNECT tunnel + absolute-URI forwarding)
// That lets one port serve both
//   curl -x socks5h://127.0.0.1:PORT ...
//   curl -x http://127.0.0.1:PORT ...
// without a second listener.
//
// Zero third-party dependencies (node:net / node:fs / node:path / node:url).
// No driver, no TUN, no root certificate, no TLS interception: bytes are
// copied verbatim between the two sockets, TLS stays end-to-end.
//
// Upstream (optional) is a plain TCP hop chosen by the operator:
//   --upstream socks5://user:pass@host:port   (SOCKS5 CONNECT)
//   --upstream http://host:port               (HTTP CONNECT)
//   --upstream ''                             (direct)
// With no upstream this is a plain direct proxy: an egress funnel, not a
// circumvention tool.
//
// Lifecycle: exits on SIGTERM / SIGINT / SIGHUP, and on stdin EOF (the host
// keeps a pipe open; a dead parent closes it), so no orphan survives a host
// crash. The listening socket and every tunnel socket are destroyed on the
// way out, which releases the port immediately.
//
// Usage:
//   node bin/proxy.js --port 7899 [--host 127.0.0.1] [--upstream URL]
//                     [--log-dir DIR] [--log-max BYTES] [--pid-file FILE]
// Prints one line on success: READY {"port":7899,...}

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

const VERSION = '0.1.0'
const MAX_HEAD_BYTES = 64 * 1024
const CONNECT_TIMEOUT_MS = 15000

// --- args --------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    host: '127.0.0.1',
    port: 0,
    upstream: '',
    logDir: '',
    logMax: 2 * 1024 * 1024,
    pidFile: '',
    parentPid: 0,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      return argv[i] === undefined ? '' : argv[i]
    }
    if (arg === '--port') out.port = Number(next())
    else if (arg === '--host') out.host = next()
    else if (arg === '--upstream') out.upstream = next()
    else if (arg === '--log-dir') out.logDir = next()
    else if (arg === '--log-max') out.logMax = Number(next()) || out.logMax
    else if (arg === '--pid-file') out.pidFile = next()
    else if (arg === '--parent-pid') out.parentPid = Number(next()) || 0
    else if (arg === '--version') {
      process.stdout.write(`dsh-local-proxy-own ${VERSION}\n`)
      process.exit(0)
    } else if (arg === '--help') {
      process.stdout.write('usage: proxy.js --port N [--host 127.0.0.1] [--upstream URL] [--log-dir DIR]\n')
      process.exit(0)
    }
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    throw new Error(`invalid --port: ${out.port}`)
  }
  return out
}

// --- logging -----------------------------------------------------------------

// ASCII-only file name and ASCII-only body: the log directory lives under a
// non-ASCII path on some hosts, and a console code page or a tail tool must
// never be able to break the record.
function sanitize(text) {
  return String(text).replace(/[^\x20-\x7E]/g, '?').slice(0, 2000)
}

function createLogger(dir, maxBytes) {
  let file = ''
  let size = 0
  let ready = false
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      file = path.join(dir, `local-proxy-${day}.log`)
      try {
        size = fs.statSync(file).size
      } catch {
        size = 0
      }
      ready = true
    } catch {
      ready = false
    }
  }
  return function log(level, message) {
    if (!ready) return
    try {
      const line = `${new Date().toISOString()} ${level} ${sanitize(message)}\n`
      const bytes = Buffer.byteLength(line)
      if (size + bytes > maxBytes) {
        try {
          fs.rmSync(`${file}.1`, { force: true })
          fs.renameSync(file, `${file}.1`)
        } catch {
          // rotation is best-effort; keep appending rather than lose records
        }
        size = 0
      }
      fs.appendFileSync(file, line)
      size += bytes
    } catch {
      // logging must never take the proxy down
    }
  }
}

// --- upstream ----------------------------------------------------------------

function parseUpstream(raw) {
  const text = String(raw || '').trim()
  if (text === '' || text.toLowerCase() === 'direct' || text.toLowerCase() === 'none') return null
  const withScheme = text.includes('://') ? text : `http://${text}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`invalid upstream: ${text}`)
  }
  const scheme = url.protocol.replace(':', '').toLowerCase()
  if (!['socks5', 'socks5h', 'http'].includes(scheme)) {
    throw new Error(`unsupported upstream protocol: ${scheme} (use socks5:// or http://)`)
  }
  const defaultPort = scheme === 'http' ? 80 : 1080
  const port = Number(url.port || defaultPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid upstream port: ${url.port}`)
  }
  return {
    kind: scheme === 'http' ? 'http' : 'socks5',
    host: url.hostname,
    port,
    username: url.username ? decodeURIComponent(url.username) : '',
    password: url.password ? decodeURIComponent(url.password) : '',
  }
}

// --- socket helpers ----------------------------------------------------------

function connectTcp(host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`connect timeout: ${host}:${port}`))
    }, timeoutMs)
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.setNoDelay(true)
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

// Sequential reader over a socket: handshakes need exact byte counts and must
// not lose bytes that arrive together with the reply.
function makeReader(socket) {
  let buffered = Buffer.alloc(0)
  let waiter = null
  let failure = null

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
  function settle() {
    if (!waiter) return
    const current = waiter
    if (failure) {
      waiter = null
      current.reject(failure)
      return
    }
    if (buffered.length >= current.need) {
      const out = buffered.subarray(0, current.need)
      buffered = buffered.subarray(current.need)
      waiter = null
      current.resolve(out)
    }
  }
  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)

  return {
    read(need) {
      return new Promise((resolve, reject) => {
        if (failure) {
          reject(failure)
          return
        }
        waiter = { need, resolve, reject }
        settle()
      })
    },
    readUntil(needle, limit = MAX_HEAD_BYTES) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const index = buffered.indexOf(needle)
          if (index >= 0) {
            const end = index + needle.length
            const out = buffered.subarray(0, end)
            buffered = buffered.subarray(end)
            resolve(out)
            return true
          }
          if (buffered.length > limit) {
            reject(new Error('header too large'))
            return true
          }
          return false
        }
        if (check()) return
        const timer = setInterval(() => {
          if (failure) {
            clearInterval(timer)
            reject(failure)
            return
          }
          if (check()) clearInterval(timer)
        }, 15)
        // readUntil is only used during a handshake with a hard deadline, so a
        // short poll keeps the code single-threaded and dependency-free.
      })
    },
    release() {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      return buffered
    },
  }
}

function ipv6ToString(buffer) {
  const parts = []
  for (let i = 0; i + 1 < buffer.length; i += 2) parts.push(buffer.readUInt16BE(i).toString(16))
  return parts.join(':')
}

// --- upstream handshakes -----------------------------------------------------

async function socks5Negotiate(socket, upstream) {
  const reader = makeReader(socket)
  const wantAuth = upstream.username !== '' || upstream.password !== ''
  const methods = wantAuth ? [0x00, 0x02] : [0x00]
  socket.write(Buffer.from([0x05, methods.length, ...methods]))
  const greeting = await reader.read(2)
  if (greeting[0] !== 0x05) throw new Error('upstream is not SOCKS5')
  if (greeting[1] === 0xff) throw new Error('upstream rejected all auth methods')
  if (greeting[1] === 0x02) {
    const user = Buffer.from(upstream.username, 'utf8')
    const pass = Buffer.from(upstream.password, 'utf8')
    if (user.length > 255 || pass.length > 255) throw new Error('upstream credential too long')
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
    const auth = await reader.read(2)
    if (auth[1] !== 0x00) throw new Error('upstream auth failed')
  }
  return reader
}

async function socks5Connect(socket, reader, host, port) {
  const head = [0x05, 0x01, 0x00]
  let address
  const version = net.isIP(host)
  if (version === 4) {
    head.push(0x01)
    address = Buffer.from(host.split('.').map((part) => Number(part) & 0xff))
  } else if (version === 6) {
    head.push(0x04)
    address = Buffer.alloc(16)
    const groups = host.split(':')
    for (let i = 0; i < 8 && i < groups.length; i += 1) address.writeUInt16BE(parseInt(groups[i] || '0', 16) & 0xffff, i * 2)
  } else {
    const name = Buffer.from(host, 'utf8')
    if (name.length > 255) throw new Error('hostname too long')
    head.push(0x03, name.length)
    address = name
  }
  const tail = Buffer.from([(port >> 8) & 0xff, port & 0xff])
  socket.write(Buffer.concat([Buffer.from(head), address, tail]))
  const reply = await reader.read(4)
  if (reply[1] !== 0x00) throw new Error(`upstream SOCKS5 refused: code ${reply[1]}`)
  const atyp = reply[3]
  if (atyp === 0x01) await reader.read(4 + 2)
  else if (atyp === 0x04) await reader.read(16 + 2)
  else if (atyp === 0x03) {
    const len = (await reader.read(1))[0]
    await reader.read(len + 2)
  } else throw new Error('upstream SOCKS5 reply has unknown address type')
}

async function httpConnect(socket, host, port) {
  const reader = makeReader(socket)
  const authority = net.isIPv6(host) ? `[${host}]` : host
  socket.write(
    `CONNECT ${authority}:${port} HTTP/1.1\r\nHost: ${authority}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`,
  )
  const head = await reader.readUntil(Buffer.from('\r\n\r\n'))
  const first = head.toString('latin1').split('\r\n')[0]
  const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(first)
  if (!match) throw new Error(`upstream HTTP proxy sent a malformed reply: ${sanitize(first)}`)
  if (Number(match[1]) !== 200) throw new Error(`upstream HTTP proxy refused: ${match[1]}`)
  return reader
}

// One function for every egress path: returns a raw byte tunnel to host:port.
async function openTunnel(host, port, upstream) {
  if (!upstream) return connectTcp(host, port)
  const socket = await connectTcp(upstream.host, upstream.port)
  try {
    if (upstream.kind === 'socks5') {
      const reader = await socks5Negotiate(socket, upstream)
      await socks5Connect(socket, reader, host, port)
      reader.release()
    } else {
      await httpConnect(socket, host, port)
    }
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

// --- connection handling -----------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2))
  const upstream = parseUpstream(args.upstream)
  const log = createLogger(args.logDir, args.logMax)
  const sockets = new Set()
  let connections = 0
  let closing = false

  if (args.pidFile) {
    try {
      fs.mkdirSync(path.dirname(args.pidFile), { recursive: true })
      fs.writeFileSync(args.pidFile, String(process.pid))
    } catch {
      // pid file is advisory only
    }
  }

  log('INFO', `start pid=${process.pid} listen=${args.host}:${args.port} upstream=${upstream ? `${upstream.kind}://${upstream.host}:${upstream.port}` : 'direct'}`)

  function attach(client, tunnel, leftover) {
    const teardown = () => {
      try {
        client.destroy()
      } catch {}
      try {
        tunnel.destroy()
      } catch {}
    }
    client.on('error', teardown)
    tunnel.on('error', teardown)
    client.on('close', () => {
      try {
        tunnel.destroy()
      } catch {}
    })
    tunnel.on('close', () => {
      try {
        client.end()
      } catch {}
    })
    if (leftover && leftover.length > 0) tunnel.write(leftover)
    tunnel.pipe(client)
    client.pipe(tunnel)
    client.resume()
  }

  function socksReply(socket, code, bound) {
    const parts = [0x05, code, 0x00]
    const address = bound && net.isIPv4(bound.address) ? bound.address : '0.0.0.0'
    const port = bound && Number.isInteger(bound.port) ? bound.port : 0
    parts.push(0x01, ...address.split('.').map((part) => Number(part) & 0xff), (port >> 8) & 0xff, port & 0xff)
    try {
      socket.write(Buffer.from(parts))
    } catch {}
  }

  function handle(client) {
    connections += 1
    client.setNoDelay(true)
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => {
      try {
        client.destroy()
      } catch {}
    })

    let stage = 'sniff'
    let buffer = Buffer.alloc(0)
    let busy = false

    const pump = () => {
      if (busy || stage === 'tunnel' || stage === 'http-stream' || stage === 'connecting') return
      busy = true
      try {
        step()
      } finally {
        busy = false
      }
    }

    function step() {
      if (stage === 'sniff') {
        if (buffer.length === 0) return
        stage = buffer[0] === 0x05 ? 'socks-greeting' : 'http-head'
      }

      if (stage === 'socks-greeting') {

        if (buffer.length < 2) return
        const count = buffer[1]
        if (buffer.length < 2 + count) return
        const methods = buffer.subarray(2, 2 + count)
        buffer = buffer.subarray(2 + count)
        if (!methods.includes(0x00)) {
          client.end(Buffer.from([0x05, 0xff]))
          stage = 'done'
          return
        }
        client.write(Buffer.from([0x05, 0x00]))
        stage = 'socks-request'
        step()
        return
      }

      if (stage === 'socks-request') {
        if (buffer.length < 5) return
        const command = buffer[1]
        const atyp = buffer[3]
        let host
        let need
        let hostStart = 4
        let hostLength = 0
        if (atyp === 0x01) {
          need = 10
          hostLength = 4
        } else if (atyp === 0x04) {
          need = 22
          hostLength = 16
        } else if (atyp === 0x03) {
          hostLength = buffer[4]
          need = 5 + hostLength + 2
          hostStart = 5
        } else {
          socksReply(client, 0x08)
          client.end()
          stage = 'done'
          return
        }
        if (buffer.length < need) return
        if (atyp === 0x01) host = [...buffer.subarray(4, 8)].join('.')
        else if (atyp === 0x04) host = ipv6ToString(buffer.subarray(4, 20))
        else host = buffer.subarray(5, 5 + hostLength).toString('ascii')
        const port = buffer.readUInt16BE(need - 2)
        const rest = buffer.subarray(need)
        buffer = Buffer.alloc(0)
        if (command !== 0x01) {
          socksReply(client, 0x07)
          client.end()
          stage = 'done'
          return
        }
        stage = 'connecting'
        client.pause()
        openTunnel(host, port, upstream).then(
          (tunnel) => {
            stage = 'tunnel'
            socksReply(client, 0x00, { address: tunnel.localAddress, port: tunnel.localPort })
            const pending = buffer
            buffer = Buffer.alloc(0)
            attach(client, tunnel, rest.length ? Buffer.concat([rest, pending]) : pending)
          },
          (error) => {
            log('WARN', `socks connect failed ${host}:${port} ${error.message}`)
            socksReply(client, 0x05)
            client.end()
          },
        )
        return
      }

      if (stage === 'http-head') {
        if (buffer.length > MAX_HEAD_BYTES) {
          client.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n')
          stage = 'done'
          return
        }
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buffer.subarray(0, end).toString('latin1')
        const rest = buffer.subarray(end + 4)
        buffer = Buffer.alloc(0)
        handleHttpHead(head, rest)
        return
      }
    }

    function handleHttpHead(head, rest) {
      const lines = head.split('\r\n')
      const requestLine = lines[0] || ''
      const match = /^([A-Z]+)\s+(\S+)\s+(HTTP\/\d\.\d)$/.exec(requestLine.trim())
      if (!match) {
        client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        stage = 'done'
        return
      }
      const method = match[1]
      const target = match[2]
      const version = match[3]
      const headers = []
      for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i]
        if (!line) continue
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
      }

      if (method === 'CONNECT') {
        const hostPort = target
        const sep = hostPort.lastIndexOf(':')
        if (sep <= 0) {
          client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
          stage = 'done'
          return
        }
        const host = hostPort.slice(0, sep).replace(/^\[|\]$/g, '')
        const port = Number(hostPort.slice(sep + 1))
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
          stage = 'done'
          return
        }
        stage = 'connecting'
        client.pause()
        openTunnel(host, port, upstream).then(
          (tunnel) => {
            stage = 'tunnel'
            client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: dsh-local-proxy-own\r\n\r\n')
            const pending = buffer
            buffer = Buffer.alloc(0)
            attach(client, tunnel, rest.length ? Buffer.concat([rest, pending]) : pending)
          },
          (error) => {
            log('WARN', `http connect failed ${host}:${port} ${error.message}`)
            client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
          },
        )
        return
      }

      let url
      try {
        url = new URL(target)
      } catch {
        client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        stage = 'done'
        return
      }
      if (url.protocol !== 'http:') {
        client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        stage = 'done'
        return
      }
      const host = url.hostname.replace(/^\[|\]$/g, '')
      const port = Number(url.port || 80)
      const requestPath = `${url.pathname || '/'}${url.search}`

      const dropHeaders = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive'])
      const out = [`${method} ${requestPath} ${version}`]
      let sawHost = false
      for (const [name, value] of headers) {
        const lower = name.toLowerCase()
        if (dropHeaders.has(lower)) continue
        if (lower === 'host') {
          sawHost = true
          out.push(`Host: ${url.host}`)
          continue
        }
        out.push(`${name}: ${value}`)
      }
      if (!sawHost) out.push(`Host: ${url.host}`)
      out.push('Connection: close')
      const payload = Buffer.from(`${out.join('\r\n')}\r\n\r\n`, 'latin1')

      stage = 'connecting'
      client.pause()
      openTunnel(host, port, upstream).then(
        (tunnel) => {
          stage = 'http-stream'
          // The request head must reach the origin before any body bytes: write
          // it first, then hand the leftover body to attach().
          tunnel.write(payload)
          const pending = buffer
          buffer = Buffer.alloc(0)
          attach(client, tunnel, rest.length ? Buffer.concat([rest, pending]) : pending)
        },
        (error) => {
          log('WARN', `http forward failed ${host}:${port} ${error.message}`)
          client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
        },
      )
    }

    client.on('data', (chunk) => {
      if (stage === 'tunnel' || stage === 'http-stream' || stage === 'done') return
      buffer = Buffer.concat([buffer, chunk])
      pump()
    })
  }

  const server = net.createServer(handle)

  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      process.stderr.write(`EADDRINUSE ${args.host}:${args.port}\n`)
      log('ERROR', `listen failed: address in use ${args.host}:${args.port}`)
      process.exit(3)
    }
    process.stderr.write(`listen error: ${error.message}\n`)
    log('ERROR', `listen error: ${error.message}`)
    process.exit(4)
  })

  server.listen(args.port, args.host, () => {
    const address = server.address()
    process.stdout.write(
      `READY ${JSON.stringify({
        port: address.port,
        host: address.address,
        upstream: upstream ? `${upstream.kind}://${upstream.host}:${upstream.port}` : 'direct',
        pid: process.pid,
        version: VERSION,
      })}\n`,
    )
  })

  function shutdown(reason) {
    if (closing) return
    closing = true
    log('INFO', `stop reason=${reason} connections=${connections}`)
    try {
      server.close()
    } catch {}
    for (const socket of sockets) {
      try {
        socket.destroy()
      } catch {}
    }
    sockets.clear()
    if (args.pidFile) {
      try {
        fs.rmSync(args.pidFile, { force: true })
      } catch {}
    }
    // Give the event loop one turn to unwatch the listening handle so the
    // port is released before the process is gone.
    setTimeout(() => process.exit(0), 50).unref()
    setTimeout(() => process.exit(0), 500)
  }

  // Parent liveness watchdog: a hard-killed host cannot close the stdin pipe
  // reliably on Windows, and an orphan listener would keep the port hostage
  // while the system proxy still points at it.
  if (args.parentPid > 0) {
    const parentAlive = () => {
      try {
        process.kill(args.parentPid, 0)
        return true
      } catch (error) {
        return Boolean(error && error.code === 'EPERM')
      }
    }
    const watchdog = setInterval(() => {
      if (!parentAlive()) shutdown('parent-gone')
    }, 4000)
    watchdog.unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))
  process.on('uncaughtException', (error) => {
    log('ERROR', `uncaught: ${error && error.stack ? error.stack : error}`)
  })

  // The host keeps this pipe open for the lifetime of the plugin and sets the
  // guard flag; EOF then means the parent is gone, so the child must not
  // outlive it. Off by default: a manual `node bin/proxy.js` under a closed or
  // /dev/null stdin must not exit on its own.
  if (process.env.LOCAL_PROXY_STDIN_GUARD === '1') {
    try {
      process.stdin.on('end', () => shutdown('stdin-eof'))
      process.stdin.on('close', () => shutdown('stdin-close'))
      process.stdin.on('error', () => shutdown('stdin-error'))
      process.stdin.resume()
    } catch {
      // no stdin: signals remain the only stop path
    }
  }
}

main()
