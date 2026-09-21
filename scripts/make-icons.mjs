/**
 * 生成应用与托盘图标（零依赖：手写最小 PNG 编码器）。
 *
 * 产物：
 *   resources/icon.png        256×256，打包用（electron-builder 会自动转 .ico）
 *   resources/tray.png         32×32，系统托盘
 *   resources/tray@2x.png      64×64，高分屏托盘
 *
 * 运行：node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** 把 RGBA 像素数组编码成 PNG。 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 画一个圆角方块 + 内部留白的"相框"图形，居中留出安全边距。 */
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const background = [0x2f, 0x7d, 0x5f, 0xff] // 品牌绿
  const foreground = [0xf3, 0xfa, 0xf5, 0xff]

  const radius = size * 0.22
  const inset = size * 0.08
  const frameInset = size * 0.26
  const frameRadius = size * 0.06

  const insideRounded = (x, y, left, top, right, bottom, r) => {
    if (x < left || x > right || y < top || y > bottom) return false
    const corners = [
      [left + r, top + r],
      [right - r, top + r],
      [left + r, bottom - r],
      [right - r, bottom - r]
    ]
    if (x > left + r && x < right - r) return true
    if (y > top + r && y < bottom - r) return true
    return corners.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r)
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4
      const inBody = insideRounded(
        x + 0.5,
        y + 0.5,
        inset,
        inset,
        size - inset,
        size - inset,
        radius
      )
      if (!inBody) {
        continue
      }
      let color = background
      // 相框外圈
      const inFrame = insideRounded(
        x + 0.5,
        y + 0.5,
        frameInset,
        frameInset,
        size - frameInset,
        size - frameInset,
        frameRadius
      )
      const inFrameInner = insideRounded(
        x + 0.5,
        y + 0.5,
        frameInset + size * 0.07,
        frameInset + size * 0.07,
        size - frameInset - size * 0.07,
        size - frameInset - size * 0.07,
        frameRadius
      )
      if (inFrame && !inFrameInner) {
        color = foreground
      }
      // 相框里的"山"形：左下到右上的斜线 + 全等简化
      const innerLeft = frameInset + size * 0.07
      const innerRight = size - frameInset - size * 0.07
      const innerTop = frameInset + size * 0.07
      const innerBottom = size - frameInset - size * 0.07
      if (
        x + 0.5 > innerLeft &&
        x + 0.5 < innerRight &&
        y + 0.5 > innerTop &&
        y + 0.5 < innerBottom
      ) {
        const t = (x + 0.5 - innerLeft) / (innerRight - innerLeft)
        const ridge = innerBottom - (innerBottom - innerTop) * (1 - Math.abs(2 * t - 1)) * 0.75
        if (y + 0.5 > ridge) {
          color = foreground
        }
        const sunX = innerLeft + (innerRight - innerLeft) * 0.74
        const sunY = innerTop + (innerBottom - innerTop) * 0.28
        const sunR = (innerRight - innerLeft) * 0.08
        if ((x + 0.5 - sunX) ** 2 + (y + 0.5 - sunY) ** 2 <= sunR * sunR) {
          color = background
        }
      }
      pixels[index] = color[0]
      pixels[index + 1] = color[1]
      pixels[index + 2] = color[2]
      pixels[index + 3] = color[3]
    }
  }

  return encodePng(size, size, pixels)
}

const root = dirname(import.meta.dirname)
const outputDir = join(root, 'resources')
mkdirSync(outputDir, { recursive: true })

for (const [file, size] of [
  ['icon.png', 256],
  ['tray.png', 32],
  ['tray@2x.png', 64]
]) {
  const target = join(outputDir, file)
  writeFileSync(target, drawIcon(size))
  console.log(`已生成 ${target}（${size}×${size}）`)
}
