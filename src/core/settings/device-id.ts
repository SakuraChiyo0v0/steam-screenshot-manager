/**
 * 设备身份。
 *
 * 设备 ID 在安装实例首次运行时生成并持久化，不写死在安装包内；
 * 单独存放为 device.json，使"复制应用数据目录后重置设备身份"变成一次显式操作
 * （docs/architecture.md 第 6 节）。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AppError } from '@shared/errors'
import type { DeviceIdFile } from '@shared/types'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isDeviceIdFile(value: unknown): value is DeviceIdFile {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<DeviceIdFile>
  return (
    typeof candidate.deviceId === 'string' &&
    UUID_PATTERN.test(candidate.deviceId) &&
    typeof candidate.createdAt === 'string' &&
    candidate.createdAt.length > 0
  )
}

/** 读取设备身份；文件不存在或内容非法时返回 null（不自动覆盖原文件）。 */
export function readDeviceId(file: string): DeviceIdFile | null {
  if (!existsSync(file)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isDeviceIdFile(parsed) ? parsed : null
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AppError('LIB_DB_CORRUPT', `设备身份文件无法解析：${detail}`)
  }
}

/** 原子写入：先写同目录临时文件，再改名，避免留下半个文件。 */
export function writeDeviceId(file: string, value: DeviceIdFile): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/** 读取已有设备身份；不存在时生成并持久化。 */
export function readOrCreateDeviceId(file: string): DeviceIdFile {
  const existing = readDeviceId(file)
  if (existing) {
    return existing
  }
  const created: DeviceIdFile = { deviceId: randomUUID(), createdAt: new Date().toISOString() }
  writeDeviceId(file, created)
  return created
}

/**
 * 显式重置设备身份：删除原文件后生成新的。
 * 用于"应用数据目录被复制到另一实例"的场景，避免两个实例共用写入命名空间。
 */
export function resetDeviceId(file: string): DeviceIdFile {
  if (existsSync(file)) {
    rmSync(file)
  }
  return readOrCreateDeviceId(file)
}
