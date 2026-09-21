/**
 * appinfo.vdf 的离线名称来源。
 *
 * Steam 客户端会把见过的应用信息（含已卸载游戏）缓存到 `appcache/appinfo.vdf`，
 * 这是**未安装游戏唯一可靠的本地名称来源**；只靠 appmanifest 会让已卸载游戏只剩 AppID。
 *
 * 文件布局（实测 v29）：
 *   uint32 magic (0x07564429)、uint32 universe、uint64 首段长度
 *   之后是连续条目：uint32 appid、uint32 size、size 字节的二进制 KV（尾部附 20 字节 SHA1）
 * 条目区结束后是字符串区，遇到非法 appid / 解析失败即停止，不猜测后续内容。
 */

import { readFileSync } from 'node:fs'
import { parseBinaryVdf, type BinaryVdfObject } from './binary-vdf'

const MAGIC = 0x07564429
const HEADER_LENGTH = 16
/** 超过这个值不可能是商店 AppID，说明已经读到字符串区。 */
const MAX_PLAUSIBLE_APPID = 50_000_000

function isObject(value: unknown): value is BinaryVdfObject {
  return typeof value === 'object' && value !== null
}

function extractName(entry: BinaryVdfObject): string | null {
  const appinfo = entry['appinfo']
  if (!isObject(appinfo)) {
    return null
  }
  const common = appinfo['common']
  if (!isObject(common)) {
    return null
  }
  const name = common['name']
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null
}

/** 读取 appid → 应用名。文件缺失或格式不认识时返回空表，不抛错。 */
export function readAppInfoNames(file: string): Map<string, string> {
  const result = new Map<string, string>()

  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return result
  }

  if (buffer.length < HEADER_LENGTH || buffer.readUInt32LE(0) !== MAGIC) {
    return result
  }

  let offset = HEADER_LENGTH
  while (offset + 8 <= buffer.length) {
    const appId = buffer.readUInt32LE(offset)
    const size = buffer.readUInt32LE(offset + 4)

    if (size === 0 || appId > MAX_PLAUSIBLE_APPID || offset + 8 + size > buffer.length) {
      break
    }

    const payload = buffer.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size

    try {
      const name = extractName(parseBinaryVdf(payload))
      if (name) {
        result.set(String(appId), name)
      }
    } catch {
      // 单条损坏不影响其余条目；若整体格式不同，后面的循环条件会自然结束
    }
  }

  return result
}

/** 从 Steam 根目录读取 appinfo.vdf 的名称表。 */
export function readAppInfoNamesForRoot(rootPath: string): Map<string, string> {
  return readAppInfoNames(`${rootPath.replace(/[\\/]+$/, '')}\\appcache\\appinfo.vdf`)
}
