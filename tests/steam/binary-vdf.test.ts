import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import {
  buildNonSteamNameMap,
  nonSteamGameId,
  parseBinaryVdf,
  readNonSteamShortcuts
} from '@core/steam/binary-vdf'

/** 构造二进制 VDF 片段的辅助函数，键名与类型字节与真实文件一致。 */
function str(key: string, value: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from(key, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(value, 'utf8'),
    Buffer.from([0x00])
  ])
}

function uint32(key: string, value: number): Buffer {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value >>> 0)
  return Buffer.concat([Buffer.from([0x02]), Buffer.from(key, 'utf8'), Buffer.from([0x00]), bytes])
}

function objStart(key: string): Buffer {
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(key, 'utf8'), Buffer.from([0x00])])
}

const OBJECT_END = Buffer.from([0x08])

/**
 * 真实实测值（docs/evidence/real-data-structure.md §3.5）：
 * GTNH 的目录名与 shortcuts.vdf 中存储的 appid。
 */
const GTNH = { storedAppid: 2821408462, gameId: '12117857072981213184', name: 'GTNH' }
const OSU = { storedAppid: 2304028794, gameId: '9895728319305875456', name: 'osu!' }

function buildShortcutsFile(
  entries: { storedAppid: number; appName: string }[]
): Buffer {
  const parts: Buffer[] = [objStart('shortcuts')]
  entries.forEach((entry, index) => {
    parts.push(objStart(String(index)))
    parts.push(uint32('appid', entry.storedAppid))
    parts.push(str('AppName', entry.appName))
    parts.push(str('Exe', '"D:\\Game\\game.exe"'))
    parts.push(OBJECT_END)
  })
  parts.push(OBJECT_END)
  return Buffer.concat(parts)
}

describe('二进制 VDF 读取器', () => {
  it('解析对象、字符串与 32 位整数', () => {
    const parsed = parseBinaryVdf(buildShortcutsFile([{ storedAppid: 123, appName: '示例' }]))
    const shortcuts = parsed['shortcuts'] as Record<string, Record<string, unknown>>
    expect(shortcuts['0']!['appid']).toBe(123)
    expect(shortcuts['0']!['AppName']).toBe('示例')
  })

  it('提前结束的缓冲区抛出可识别错误', () => {
    expect(() => parseBinaryVdf(Buffer.from([0x01, 0x6b]))).toThrowError(AppError)
  })

  it('遇到不支持的类型字节时抛错', () => {
    // 0x0A 是未支持的类型字节（宽字符串 0x05 已支持，用于 appinfo）
    const buffer = Buffer.concat([
      objStart('shortcuts'),
      Buffer.from([0x0a]),
      Buffer.from('x', 'utf8'),
      Buffer.from([0x00])
    ])
    expect(() => parseBinaryVdf(buffer)).toThrowError(AppError)
  })
})

describe('非 Steam 快捷方式与 gameID 换算', () => {
  it('读取全部快捷方式', () => {
    const shortcuts = readNonSteamShortcuts(
      buildShortcutsFile([
        { storedAppid: GTNH.storedAppid, appName: GTNH.name },
        { storedAppid: OSU.storedAppid, appName: OSU.name }
      ])
    )
    expect(shortcuts).toHaveLength(2)
    expect(shortcuts[0]!.appName).toBe(GTNH.name)
  })

  it('gameID 换算与真实目录名一致', () => {
    // 低位恒为 0x02000000，高位为存储的 32 位 appid
    expect(nonSteamGameId(GTNH.storedAppid)).toBe(GTNH.gameId)
    expect(nonSteamGameId(OSU.storedAppid)).toBe(OSU.gameId)
  })

  it('负的 int32 读取值也能正确换算（写回无符号）', () => {
    const negativeForm = GTNH.storedAppid - 0x100000000
    expect(nonSteamGameId(negativeForm)).toBe(GTNH.gameId)
  })

  it('建立 gameID → 名称映射', () => {
    const map = buildNonSteamNameMap(
      readNonSteamShortcuts(
        buildShortcutsFile([{ storedAppid: GTNH.storedAppid, appName: GTNH.name }])
      )
    )
    expect(map.get(GTNH.gameId)).toBe(GTNH.name)
  })

  it('缺少 shortcuts 键时返回空数组', () => {
    expect(readNonSteamShortcuts(Buffer.from([0x08]))).toEqual([])
  })
})
