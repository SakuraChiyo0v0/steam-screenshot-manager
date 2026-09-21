/**
 * 远端图库布局与记录格式（docs/sync-protocol.md §2、§4、§6）。
 *
 * 远端结构：
 *   <根>/steam-gallery-v1/<libraryId>/
 *     library.json
 *     originals/<accountKey>/<gameKey>/<deviceId>/<uploadId>/<sha256>.<ext>
 *     records/<deviceId>/<YYYY-MM>/<recordId>.json
 *
 * 每个设备写自己的对象与记录，不共同更新一个索引；对象先上传，记录最后发布。
 */

import { AppError } from '@shared/errors'

export const LIBRARY_FORMAT_VERSION = 1
export const LIBRARY_DIR_NAME = 'steam-gallery-v1'

export interface LibraryDescriptor {
  readonly schemaVersion: number
  readonly libraryId: string
  readonly createdAt: string
}

export function libraryRootPath(libraryId: string): string {
  return `${LIBRARY_DIR_NAME}/${libraryId}`
}

export function libraryDescriptorPath(libraryId: string): string {
  return `${libraryRootPath(libraryId)}/library.json`
}

export function buildLibraryDescriptor(libraryId: string, createdAt: string): LibraryDescriptor {
  return { schemaVersion: LIBRARY_FORMAT_VERSION, libraryId, createdAt }
}

/** 描述文件只含格式版本、库标识与创建时间，不含统计与凭据。 */
export function validateLibraryDescriptor(
  value: unknown,
  expectedLibraryId?: string
): { ok: true; descriptor: LibraryDescriptor } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: '描述文件不是对象' }
  }
  const candidate = value as Partial<LibraryDescriptor>
  if (candidate.schemaVersion !== LIBRARY_FORMAT_VERSION) {
    return { ok: false, reason: `不支持的格式版本：${String(candidate.schemaVersion)}` }
  }
  if (typeof candidate.libraryId !== 'string' || candidate.libraryId.length < 8) {
    return { ok: false, reason: 'libraryId 非法' }
  }
  if (expectedLibraryId && candidate.libraryId !== expectedLibraryId) {
    return { ok: false, reason: 'libraryId 与目录不一致' }
  }
  return {
    ok: true,
    descriptor: {
      schemaVersion: candidate.schemaVersion,
      libraryId: candidate.libraryId,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : ''
    }
  }
}

export interface ObjectKeyInput {
  readonly accountKey: string
  readonly gameKey: string
  readonly deviceId: string
  readonly uploadId: string
  readonly sha256: string
  readonly ext: string
}

/** 设备独立、不可变的物理对象路径。 */
export function buildObjectKey(libraryId: string, input: ObjectKeyInput): string {
  const ext = input.ext.startsWith('.') ? input.ext : `.${input.ext}`
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) {
    throw new AppError('LIB_HASH_MISMATCH', '指纹格式非法')
  }
  return `${libraryRootPath(libraryId)}/originals/${input.accountKey}/${input.gameKey}/${input.deviceId}/${input.uploadId}/${input.sha256.toLowerCase()}${ext}`
}

export function buildRecordKey(
  libraryId: string,
  input: { deviceId: string; recordId: string; at: Date }
): string {
  const month = `${input.at.getUTCFullYear()}-${String(input.at.getUTCMonth() + 1).padStart(2, '0')}`
  return `${libraryRootPath(libraryId)}/records/${input.deviceId}/${month}/${input.recordId}.json`
}

const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.avif': 'image/avif',
  '.tga': 'image/x-tga'
}

export function mediaTypeFor(ext: string): string {
  const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  return MEDIA_TYPES[normalized] ?? 'application/octet-stream'
}

export interface RecordInput {
  readonly libraryId: string
  readonly recordId: string
  readonly deviceId: string
  readonly accountKey: string
  readonly gameKey: string
  readonly gameName: string | null
  readonly originalFilename: string
  readonly sha256: string
  readonly bytes: number
  readonly ext: string
  readonly width: number | null
  readonly height: number | null
  readonly capturedAt: string | null
  readonly captureTimeSource: string
  readonly importedAt: string
  readonly objectKey: string
}

export interface RemoteRecord {
  readonly schemaVersion: number
  readonly libraryId: string
  readonly recordId: string
  readonly deviceId: string
  readonly accountKey: string
  readonly gameKey: string
  readonly gameName?: string
  readonly originalFilename: string
  readonly sha256: string
  readonly bytes: number
  readonly mediaType: string
  readonly width?: number
  readonly height?: number
  readonly capturedAt?: string
  readonly captureTimeHint?: string
  readonly captureTimeSource?: string
  readonly captureTimeZone?: null
  readonly importedAt: string
  readonly objectKey: string
}

/**
 * 生成不可变记录。字节数必须为正整数；没有的字段不写，
 * 不允许为通过校验而杜撰尺寸或时区。
 */
export function buildRecord(input: RecordInput): RemoteRecord {
  if (!Number.isInteger(input.bytes) || input.bytes <= 0) {
    throw new AppError('APP_INTERNAL', `字节数非法：${input.bytes}`)
  }

  const record: RemoteRecord = {
    schemaVersion: LIBRARY_FORMAT_VERSION,
    libraryId: input.libraryId,
    recordId: input.recordId,
    deviceId: input.deviceId,
    accountKey: input.accountKey,
    gameKey: input.gameKey,
    ...(input.gameName ? { gameName: input.gameName } : {}),
    originalFilename: input.originalFilename,
    sha256: input.sha256,
    bytes: input.bytes,
    mediaType: mediaTypeFor(input.ext),
    ...(input.width !== null ? { width: input.width } : {}),
    ...(input.height !== null ? { height: input.height } : {}),
    ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
    ...(input.capturedAt ? { captureTimeSource: input.captureTimeSource } : {}),
    importedAt: input.importedAt,
    objectKey: input.objectKey
  }
  return record
}

export interface RecordValidationInput {
  readonly libraryId: string
  readonly recordId: string
  readonly objectKey: string
  readonly sha256: string
  readonly bytes: number
}

/** 读回记录后的完整校验：结构、关键字段、路径范围、数值合法性。 */
export function validateRecord(
  value: unknown,
  expected: RecordValidationInput
): { ok: true } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: '记录不是对象' }
  }
  const record = value as Partial<RemoteRecord>

  if (record.schemaVersion !== LIBRARY_FORMAT_VERSION) {
    return { ok: false, reason: `不支持的记录版本：${String(record.schemaVersion)}` }
  }
  if (record.libraryId !== expected.libraryId) {
    return { ok: false, reason: 'libraryId 与当前图库不一致' }
  }
  if (record.recordId !== expected.recordId) {
    return { ok: false, reason: 'recordId 不一致' }
  }
  if (record.objectKey !== expected.objectKey) {
    return { ok: false, reason: 'objectKey 不一致' }
  }
  if (typeof record.sha256 !== 'string' || record.sha256.toLowerCase() !== expected.sha256.toLowerCase()) {
    return { ok: false, reason: '指纹不一致' }
  }
  if (record.bytes !== expected.bytes) {
    return { ok: false, reason: '字节数不一致' }
  }
  for (const field of ['accountKey', 'gameKey', 'originalFilename', 'importedAt', 'deviceId'] as const) {
    const value2 = record[field]
    if (typeof value2 !== 'string' || value2.length === 0 || value2.length > 512) {
      return { ok: false, reason: `字段 ${field} 非法` }
    }
  }

  // 对象路径必须落在本图库内，且不包含越界片段
  const objectKey = record.objectKey
  if (
    typeof objectKey !== 'string' ||
    objectKey.includes('..') ||
    objectKey.includes('\\') ||
    objectKey.startsWith('/') ||
    !objectKey.startsWith(`${libraryRootPath(expected.libraryId)}/originals/`)
  ) {
    return { ok: false, reason: 'objectKey 越出图库范围' }
  }

  for (const field of ['width', 'height'] as const) {
    const value3 = record[field]
    if (value3 !== undefined && (!Number.isInteger(value3) || (value3 as number) < 0)) {
      return { ok: false, reason: `字段 ${field} 不是非负整数` }
    }
  }

  return { ok: true }
}
