#!/usr/bin/env node
// Generates the CanBang firecracker brand assets (SVG, PNG, ICO) into web/.
// Pure Node: canvas helpers + minimal PNG/ICO encoders, no dependencies.

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')
mkdirSync(outDir, { recursive: true })

function makeCanvas(w, h) {
  return { w, h, data: new Uint8Array(w * h * 4) }
}

function setPx(c, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return
  const i = (y * c.w + x) * 4
  c.data[i] = r
  c.data[i + 1] = g
  c.data[i + 2] = b
  c.data[i + 3] = a
}

function fillRect(c, x0, y0, x1, y1, col) {
  for (let y = Math.floor(y0); y <= Math.floor(y1); y++)
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) setPx(c, x, y, ...col)
}

function fillCircle(c, cx, cy, rad, col) {
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++)
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) setPx(c, x, y, ...col)
}

function strokeLine(c, x0, y0, x1, y1, t, col) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps
    const y = y0 + ((y1 - y0) * i) / steps
    fillCircle(c, x, y, t / 2, col)
  }
}

function fillRoundRect(c, x0, y0, x1, y1, r, col) {
  fillRect(c, x0, y0 + r, x1, y1 - r, col)
  fillRect(c, x0 + r, y0, x1 - r, y1, col)
  fillCircle(c, x0 + r, y0 + r, r, col)
  fillCircle(c, x1 - r, y0 + r, r, col)
  fillCircle(c, x0 + r, y1 - r, r, col)
  fillCircle(c, x1 - r, y1 - r, r, col)
}

// Firecracker mark, drawn in a 32-unit space then scaled to any size.
function drawFirecracker(c, size) {
  const u = size / 32
  // body outline + fill
  fillRoundRect(
    c,
    10 * u - 1.5 * u,
    11.5 * u - 1.5 * u,
    22 * u + 1.5 * u,
    27 * u + 1.5 * u,
    3.5 * u,
    [159, 18, 57],
  )
  fillRoundRect(c, 10 * u, 11.5 * u, 22 * u, 27 * u, 2.5 * u, [225, 29, 72])
  // gold band near the top
  fillRoundRect(c, 10 * u, 11.5 * u, 22 * u, 15 * u, 2 * u, [245, 158, 11])
  // fuse
  strokeLine(c, 16 * u, 10.5 * u, 22.5 * u, 4.5 * u, 1.8 * u, [146, 64, 14])
  // spark
  fillCircle(c, 22.8 * u, 3.8 * u, 3 * u, [253, 224, 71])
  fillCircle(c, 22.8 * u, 3.8 * u, 1.4 * u, [255, 251, 235])
  for (const [dx, dy] of [
    [4, 0],
    [-4, 0],
    [0, 4],
    [0, -4],
    [3, 3],
    [-3, 3],
    [3, -3],
    [-3, -3],
  ]) {
    strokeLine(
      c,
      22.8 * u + dx * 0.6 * u,
      3.8 * u + dy * 0.6 * u,
      22.8 * u + dx * u,
      3.8 * u + dy * u,
      1.2 * u,
      [253, 224, 71],
    )
  }
}

// ---- PNG encoder (RGBA, 8-bit) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(c) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(c.w, 0)
  ihdr.writeUInt32BE(c.h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = c.w * 4
  const raw = Buffer.alloc(c.h * (stride + 1))
  for (let y = 0; y < c.h; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(c.data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- ICO encoder (32x32, 32-bit BMP-in-ICO) ----
function encodeICO(c) {
  const w = c.w
  const h = c.h
  const xor = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((h - 1 - y) * w + x) * 4
      const dst = (y * w + x) * 4
      xor[dst] = c.data[src + 2] // B
      xor[dst + 1] = c.data[src + 1] // G
      xor[dst + 2] = c.data[src] // R
      xor[dst + 3] = c.data[src + 3] // A
    }
  }
  const maskRowBytes = Math.ceil(w / 32) * 4
  const mask = Buffer.alloc(maskRowBytes * h)
  const bmp = Buffer.alloc(40)
  bmp.writeUInt32LE(40, 0)
  bmp.writeInt32LE(w, 4)
  bmp.writeInt32LE(h * 2, 8)
  bmp.writeUInt16LE(1, 12)
  bmp.writeUInt16LE(32, 14)
  bmp.writeUInt32LE(0, 16)
  bmp.writeUInt32LE(xor.length, 20)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry[0] = w
  entry[1] = h
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(40 + xor.length + mask.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, bmp, xor, mask])
}

function render(size) {
  const c = makeCanvas(size, size)
  drawFirecracker(c, size)
  return c
}

writeFileSync(join(outDir, 'favicon.ico'), encodeICO(render(32)))
writeFileSync(join(outDir, 'favicon-32x32.png'), encodePNG(render(32)))
writeFileSync(join(outDir, 'apple-touch-icon.png'), encodePNG(render(180)))
writeFileSync(join(outDir, 'icon-512.png'), encodePNG(render(512)))

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="8.5" y="10" width="15" height="19" rx="3.5" fill="#9f1239"/>
  <rect x="10" y="11.5" width="12" height="16" rx="2.5" fill="#e11d48"/>
  <rect x="10" y="11.5" width="12" height="3.5" rx="2" fill="#f59e0b"/>
  <path d="M16 11 C18 7.5 20 6 22.5 4.5" stroke="#92400e" stroke-width="1.8" fill="none" stroke-linecap="round"/>
  <circle cx="22.8" cy="3.8" r="3" fill="#fde047"/>
  <circle cx="22.8" cy="3.8" r="1.4" fill="#fffbe6"/>
  <g stroke="#fde047" stroke-width="1.2" stroke-linecap="round">
    <line x1="26.8" y1="3.8" x2="28" y2="3.8"/><line x1="18.8" y1="3.8" x2="17.6" y2="3.8"/>
    <line x1="22.8" y1="7.8" x2="22.8" y2="9"/><line x1="22.8" y1="-0.2" x2="22.8" y2="-1.4"/>
    <line x1="25.7" y1="6.7" x2="26.5" y2="7.5"/><line x1="19.9" y1="0.9" x2="19.1" y2="0.1"/>
    <line x1="25.7" y1="0.9" x2="26.5" y2="0.1"/><line x1="19.9" y1="6.7" x2="19.1" y2="7.5"/>
  </g>
</svg>
`
writeFileSync(join(outDir, 'logo.svg'), svg)
writeFileSync(join(outDir, 'favicon.svg'), svg)

console.log(`generated brand assets in ${outDir}`)
