import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import {
  readDeviceId,
  readOrCreateDeviceId,
  resetDeviceId,
  writeDeviceId
} from '@core/settings/device-id'

let workDir: string
let deviceFile: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ssm-device-'))
  deviceFile = join(workDir, 'device.json')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('设备身份', () => {
  it('首次读取时生成并持久化设备 ID', () => {
    expect(existsSync(deviceFile)).toBe(false)

    const created = readOrCreateDeviceId(deviceFile)

    expect(existsSync(deviceFile)).toBe(true)
    expect(created.deviceId).toMatch(UUID_PATTERN)
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false)
  })

  it('重复读取返回同一设备 ID', () => {
    const first = readOrCreateDeviceId(deviceFile)
    const second = readOrCreateDeviceId(deviceFile)

    expect(second.deviceId).toBe(first.deviceId)
  })

  it('重置后生成新的设备 ID', () => {
    const first = readOrCreateDeviceId(deviceFile)
    const reset = resetDeviceId(deviceFile)

    expect(reset.deviceId).not.toBe(first.deviceId)
    expect(readDeviceId(deviceFile)?.deviceId).toBe(reset.deviceId)
  })

  it('写入使用原子改名，不残留临时文件', () => {
    readOrCreateDeviceId(deviceFile)

    expect(existsSync(`${deviceFile}.tmp`)).toBe(false)
  })

  it('内容不是合法 JSON 时报错，且不覆盖原文件', () => {
    writeFileSync(deviceFile, '这不是 JSON', 'utf8')

    expect(() => readDeviceId(deviceFile)).toThrowError(AppError)
    expect(readFileSync(deviceFile, 'utf8')).toBe('这不是 JSON')
  })

  it('JSON 合法但字段非法时返回 null，不自动覆盖', () => {
    writeFileSync(deviceFile, JSON.stringify({ deviceId: '不是 UUID' }), 'utf8')

    expect(readDeviceId(deviceFile)).toBeNull()
    expect(readOrCreateDeviceId(deviceFile).deviceId).toMatch(UUID_PATTERN)
  })

  it('写入的值可被原样读回', () => {
    const value = { deviceId: '11111111-2222-4333-8444-555555555555', createdAt: '2026-09-20T00:00:00.000Z' }
    writeDeviceId(deviceFile, value)

    expect(readDeviceId(deviceFile)).toEqual(value)
  })
})
