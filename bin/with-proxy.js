#!/usr/bin/env node
// with-proxy.js - run ONE program through the local proxy, per-process.
//
//   node with-proxy.js [--port 7899] [--split cn-direct|all] -- <exe> [args...]
//   node with-proxy.js -- curl -s https://api.ip.sb/geoip
//
// This is the honest form of "route only this app": without a TUN adapter there
// is no way to hijack another running process, and we are not creating one. So
// instead the child is born with HTTP_PROXY / HTTPS_PROXY / ALL_PROXY set in its
// own environment block. Nothing else on the machine changes: no system proxy,
// no route table, no adapter, no firewall rule. When the child exits, the
// routing dies with it.
//
// Apps that ignore proxy env vars (most native Windows GUI apps) will not be
// routed. For those use the PAC (bin/pac.js) and point the app at it.
import { spawn } from 'node:child_process'
import { proxyEnv } from './route-rules.js'

function argval(argv, name, dflt) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
if (sep < 0 || !argv[sep + 1]) {
  process.stderr.write('usage: with-proxy.js [--port 7899] [--split cn-direct|all] -- <exe> [args...]\n')
  process.exit(2)
}
const flags = argv.slice(0, sep)
const [exe, ...args] = argv.slice(sep + 1)
const port = parseInt(argval(flags, '--port', '7899'), 10)
const host = argval(flags, '--host', '127.0.0.1')
const mode = argval(flags, '--split', 'cn-direct')

const child = spawn(exe, args, {
  stdio: 'inherit',
  windowsHide: false,
  env: { ...process.env, ...proxyEnv({ port, host, mode }) },
})
child.on('error', (e) => {
  process.stderr.write(`cannot run ${exe}: ${e.message}\n`)
  process.exit(127)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code === null ? 1 : code)
})
