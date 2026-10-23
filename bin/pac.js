#!/usr/bin/env node
// pac.js - write a PAC file so browsers/system-proxy consumers split traffic
// without us ever flipping the Windows global proxy ourselves.
//
//   node pac.js [--port 7899] [--host 127.0.0.1] [--split cn-direct|all|direct]
//               [--out FILE] [--print]
//
// The domestic list is inline (route-rules.js). Nothing is fetched at runtime,
// so the PAC keeps working when a subscription or rule CDN is down.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPac, MODES } from './route-rules.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')

function argval(argv, name, dflt) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}

const argv = process.argv.slice(2)
const host = argval(argv, '--host', '127.0.0.1')
const port = parseInt(argval(argv, '--port', '7899'), 10)
const mode = argval(argv, '--split', 'cn-direct')
if (!MODES.includes(mode)) {
  process.stderr.write(`unknown --split ${mode} (use ${MODES.join('|')})\n`)
  process.exit(2)
}
const out = path.resolve(argval(argv, '--out', path.join(PKG, '.runtime', 'proxy.pac')))
const body = buildPac({ host, port, mode })
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, body, 'utf8')

const result = { ok: true, file: out, url: 'file:///' + out.replace(/\\/g, '/'), host, port, mode, bytes: body.length }
if (argv.includes('--print')) {
  console.log(body)
} else {
  console.log(JSON.stringify(result, null, 2))
}
