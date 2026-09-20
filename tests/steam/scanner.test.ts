import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  accountKeyFor,
  gameKeyFor,
  hashFile,
  parseGameDirectory
} from '@core/steam/scanner'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ssm-scan-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('游戏目录名解析', () => {
  it('普通 AppID 识别为 Steam 游戏', () => {
    expect(parseGameDirectory('438100')).toEqual({ kind: 'steam', gameId: '438100' })
  })

  it('超过 2³² 的目录名识别为非 Steam 快捷方式', () => {
    expect(parseGameDirectory('12117857072981213184')).toEqual({
      kind: 'non-steam',
      gameId: '12117857072981213184'
    })
    expect(parseGameDirectory('9895728319305875456')).toEqual({
      kind: 'non-steam',
      gameId: '9895728319305875456'
    })
  })

  it('非数字目录名被忽略', () => {
    expect(parseGameDirectory('thumbnails')).toBeNull()
    expect(parseGameDirectory('steam-438100')).toBeNull()
  })

  it('gameKey 命名空间区分 Steam 与非 Steam', () => {
    expect(gameKeyFor('steam', '438100')).toBe('steam-438100')
    expect(gameKeyFor('non-steam', '12117857072981213184')).toBe(
      'shortcut-12117857072981213184'
    )
  })

  it('账号键固定为 steam-<AccountID>', () => {
    expect(accountKeyFor('1000000001')).toBe('steam-1000000001')
  })
})

describe('内容指纹', () => {
  it('SHA-256 与已知值一致', async () => {
    const file = join(workDir, 'abc.txt')
    writeFileSync(file, 'abc')

    const expected = createHash('sha256').update('abc').digest('hex')
    expect(await hashFile(file)).toBe(expected)
    expect(expected).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('同样的内容产生同样的哈希（重复扫描可复用）', async () => {
    const a = join(workDir, 'a.jpg')
    const b = join(workDir, 'b.jpg')
    writeFileSync(a, 'same-bytes')
    writeFileSync(b, 'same-bytes')

    expect(await hashFile(a)).toBe(await hashFile(b))
  })

  it('文件不存在时抛出异常（由调用方记录为单文件失败）', async () => {
    await expect(hashFile(join(workDir, 'missing.jpg'))).rejects.toThrow()
  })
})
