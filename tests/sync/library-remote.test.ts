import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import {
  buildLibraryDescriptor,
  buildObjectKey,
  buildRecord,
  buildRecordKey,
  mediaTypeFor,
  validateLibraryDescriptor,
  validateRecord
} from '@core/sync/library-remote'
import { backoffMs } from '@core/sync/upload'

const LIBRARY_ID = '0f0f0f0f-1111-4222-8333-444444444444'
const SHA = 'a'.repeat(64)

describe('远端布局', () => {
  it('对象路径按设备与上传批次隔离，文件名是指纹', () => {
    const key = buildObjectKey(LIBRARY_ID, {
      accountKey: 'steam-1',
      gameKey: 'steam-438100',
      deviceId: 'dev-1',
      uploadId: 'up-1',
      sha256: SHA,
      ext: 'jpg'
    })
    expect(key).toBe(
      `steam-gallery-v1/${LIBRARY_ID}/originals/steam-1/steam-438100/dev-1/up-1/${SHA}.jpg`
    )
  })

  it('记录按月分目录', () => {
    const key = buildRecordKey(LIBRARY_ID, {
      deviceId: 'dev-1',
      recordId: 'rec-1',
      at: new Date('2026-05-04T10:00:00.000Z')
    })
    expect(key).toBe(`steam-gallery-v1/${LIBRARY_ID}/records/dev-1/2026-05/rec-1.json`)
  })

  it('指纹格式非法时拒绝生成路径', () => {
    expect(() =>
      buildObjectKey(LIBRARY_ID, {
        accountKey: 'a',
        gameKey: 'b',
        deviceId: 'd',
        uploadId: 'u',
        sha256: 'not-a-hash',
        ext: 'jpg'
      })
    ).toThrow(AppError)
  })
})

describe('library.json 校验', () => {
  it('接受同库的描述文件', () => {
    const descriptor = buildLibraryDescriptor(LIBRARY_ID, '2026-05-04T10:00:00.000Z')
    expect(validateLibraryDescriptor(descriptor, LIBRARY_ID).ok).toBe(true)
  })

  it('拒绝版本不符与库标识不一致', () => {
    expect(validateLibraryDescriptor({ schemaVersion: 99, libraryId: LIBRARY_ID }).ok).toBe(false)
    expect(
      validateLibraryDescriptor(
        { schemaVersion: 1, libraryId: '11111111-2222-4333-8444-555555555555' },
        LIBRARY_ID
      ).ok
    ).toBe(false)
  })
})

describe('记录构造与校验', () => {
  function makeRecord(overrides: Record<string, unknown> = {}) {
    return {
      ...buildRecord({
        libraryId: LIBRARY_ID,
        recordId: 'rec-1',
        deviceId: 'dev-1',
        accountKey: 'steam-1',
        gameKey: 'steam-438100',
        gameName: 'VRChat',
        originalFilename: 'a.jpg',
        sha256: SHA,
        bytes: 1234,
        ext: 'jpg',
        width: 1920,
        height: 1080,
        capturedAt: '2026-05-04T10:00:00.000Z',
        captureTimeSource: 'screenshot-index',
        importedAt: '2026-05-05T10:00:00.000Z',
        objectKey: `steam-gallery-v1/${LIBRARY_ID}/originals/steam-1/steam-438100/dev-1/up-1/${SHA}.jpg`
      }),
      ...overrides
    }
  }

  const expected = {
    libraryId: LIBRARY_ID,
    recordId: 'rec-1',
    objectKey: `steam-gallery-v1/${LIBRARY_ID}/originals/steam-1/steam-438100/dev-1/up-1/${SHA}.jpg`,
    sha256: SHA,
    bytes: 1234
  }

  it('合法记录通过校验', () => {
    expect(validateRecord(makeRecord(), expected).ok).toBe(true)
  })

  it('缺少拍摄时间时不写捕获字段，也不伪造时区', () => {
    const record = buildRecord({
      libraryId: LIBRARY_ID,
      recordId: 'rec-2',
      deviceId: 'dev-1',
      accountKey: 'steam-1',
      gameKey: 'steam-438100',
      gameName: null,
      originalFilename: 'b.jpg',
      sha256: SHA,
      bytes: 10,
      ext: 'jpg',
      width: null,
      height: null,
      capturedAt: null,
      captureTimeSource: 'unknown',
      importedAt: '2026-05-05T10:00:00.000Z',
      objectKey: expected.objectKey
    })
    expect(record.capturedAt).toBeUndefined()
    expect(record.captureTimeSource).toBeUndefined()
    expect(record.gameName).toBeUndefined()
    expect(record.width).toBeUndefined()
  })

  it('拒绝字节数非法', () => {
    expect(() =>
      buildRecord({
        libraryId: LIBRARY_ID,
        recordId: 'rec-3',
        deviceId: 'dev-1',
        accountKey: 'steam-1',
        gameKey: 'steam-438100',
        gameName: null,
        originalFilename: 'c.jpg',
        sha256: SHA,
        bytes: 0,
        ext: 'jpg',
        width: null,
        height: null,
        capturedAt: null,
        captureTimeSource: 'unknown',
        importedAt: '2026-05-05T10:00:00.000Z',
        objectKey: expected.objectKey
      })
    ).toThrow(AppError)
  })

  it('读回校验拦住字段不一致与越界路径', () => {
    expect(validateRecord(makeRecord({ bytes: 999 }), expected).ok).toBe(false)
    expect(validateRecord(makeRecord({ sha256: 'b'.repeat(64) }), expected).ok).toBe(false)
    expect(validateRecord(makeRecord({ recordId: 'other' }), expected).ok).toBe(false)
    expect(validateRecord(makeRecord({ objectKey: 'other-lib/originals/x.jpg' }), expected).ok).toBe(
      false
    )
    expect(validateRecord(makeRecord({ objectKey: `${expected.objectKey}/../escape` }), expected).ok).toBe(
      false
    )
    expect(validateRecord(makeRecord({ width: -1 }), expected).ok).toBe(false)
    expect(validateRecord({ schemaVersion: 99 }, expected).ok).toBe(false)
  })

  it('媒体类型按扩展名映射', () => {
    expect(mediaTypeFor('jpg')).toBe('image/jpeg')
    expect(mediaTypeFor('.PNG')).toBe('image/png')
    expect(mediaTypeFor('unknown')).toBe('application/octet-stream')
  })
})

describe('重试退避', () => {
  it('优先使用服务端给的等待时间并封顶', () => {
    expect(backoffMs(3, 1500)).toBe(1500)
    expect(backoffMs(1, 10 * 60 * 1000)).toBe(5 * 60 * 1000)
  })

  it('没有服务端提示时按次数指数增长且不超过 60 秒', () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const value = backoffMs(attempt)
      expect(value).toBeGreaterThanOrEqual(2000)
      expect(value).toBeLessThanOrEqual(66000)
    }
    expect(backoffMs(5)).toBeGreaterThan(backoffMs(1))
  })
})
