/**
 * 二进制 VDF（KeyValues Binary）读取器。
 *
 * 用途：解析 `userdata\<AccountID>\config\shortcuts.vdf`——非 Steam 快捷方式的定义。
 * 该文件是二进制格式，`@node-steam/vdf` 只支持文本 VDF，因此这里实现最小读取器。
 *
 * 已实现的类型字节：
 *   0x00 对象开始、0x01 字符串、0x02 int32、0x07 uint64、0x08 对象结束。
 * 其他类型（浮点、宽字符串、颜色等）在 shortcuts.vdf 中不出现，遇到时抛出可识别的解析错误。
 */

import { AppError } from '@shared/errors'

const TYPE_OBJECT_START = 0x00
const TYPE_STRING = 0x01
const TYPE_INT32 = 0x02
const TYPE_UINT64 = 0x07
const TYPE_OBJECT_END = 0x08

export type BinaryVdfValue = string | number | BinaryVdfObject

export interface BinaryVdfObject {
  [key: string]: BinaryVdfValue
}

class BinaryVdfReader {
  private offset = 0

  constructor(private readonly buffer: Buffer) {}

  private ensure(length: number): void {
    if (this.offset + length > this.buffer.length) {
      throw new AppError('SRC_VDF_PARSE', '二进制 VDF 提前结束')
    }
  }

  private readByte(): number {
    this.ensure(1)
    return this.buffer[this.offset++]!
  }

  private readInt32(): number {
    this.ensure(4)
    const value = this.buffer.readInt32LE(this.offset)
    this.offset += 4
    return value
  }

  private readUInt64(): number {
    this.ensure(8)
    const value = this.buffer.readBigUInt64LE(this.offset)
    this.offset += 8
    // 非 Steam 快捷方式的 storedAppid 是 32 位，这里只为兼容可能出现的 64 位字段
    return Number(value)
  }

  private readCString(): string {
    const end = this.buffer.indexOf(0x00, this.offset)
    if (end < 0) {
      throw new AppError('SRC_VDF_PARSE', '二进制 VDF 字符串未以 0x00 结束')
    }
    const value = this.buffer.toString('utf8', this.offset, end)
    this.offset = end + 1
    return value
  }

  readObject(): BinaryVdfObject {
    const result: BinaryVdfObject = {}

    for (;;) {
      if (this.offset >= this.buffer.length) {
        // 顶层对象没有显式的结束字节时也接受，避免因尾随填充导致整份文件不可用
        return result
      }

      const type = this.readByte()
      if (type === TYPE_OBJECT_END) {
        return result
      }

      const key = this.readCString()

      switch (type) {
        case TYPE_OBJECT_START:
          result[key] = this.readObject()
          break
        case TYPE_STRING:
          result[key] = this.readCString()
          break
        case TYPE_INT32:
          result[key] = this.readInt32()
          break
        case TYPE_UINT64:
          result[key] = this.readUInt64()
          break
        default:
          throw new AppError('SRC_VDF_PARSE', `不支持的二进制 VDF 类型字节 0x${type.toString(16)}`)
      }
    }
  }
}

export function parseBinaryVdf(buffer: Buffer): BinaryVdfObject {
  return new BinaryVdfReader(buffer).readObject()
}

export interface NonSteamShortcut {
  /** shortcuts.vdf 中存储的 32 位 appid */
  readonly storedAppid: number
  readonly appName: string
}

/** `gameID = (storedAppid << 32) | 0x02000000`（docs/evidence/real-data-structure.md 实测确认）。 */
export function nonSteamGameId(storedAppid: number): string {
  const value = (BigInt(storedAppid >>> 0) << 32n) | 0x02000000n
  return value.toString()
}

function isObject(value: BinaryVdfValue | undefined): value is BinaryVdfObject {
  return typeof value === 'object' && value !== null
}

/** 从二进制 shortcuts.vdf 内容中取出全部快捷方式的 appid 与名称。 */
export function readNonSteamShortcuts(buffer: Buffer): NonSteamShortcut[] {
  const root = parseBinaryVdf(buffer)
  const shortcuts = root['shortcuts']
  if (!isObject(shortcuts)) {
    return []
  }

  const result: NonSteamShortcut[] = []
  for (const value of Object.values(shortcuts)) {
    if (!isObject(value)) {
      continue
    }
    const storedAppid = value['appid']
    const appName = value['AppName']
    if (typeof storedAppid !== 'number') {
      continue
    }
    result.push({
      storedAppid,
      appName: typeof appName === 'string' ? appName : ''
    })
  }
  return result
}

/** 建立 gameID → 名称映射，供截图目录名为高位 gameID 的游戏取名。 */
export function buildNonSteamNameMap(shortcuts: readonly NonSteamShortcut[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const shortcut of shortcuts) {
    map.set(nonSteamGameId(shortcut.storedAppid), shortcut.appName)
  }
  return map
}
