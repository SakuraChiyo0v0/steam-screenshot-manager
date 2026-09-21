import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanSource, type ScanRequest, type ScanProgress } from '@core/steam/scanner'

/**
 * 扫描进度与取消的契约。
 *
 * 补齐归档变更 2026-09-21-gallery-data-integration 任务 4.5 的缺口：
 * 进度形状（阶段 / 已处理 / 总量 / 当前文件）与「取消在文件之间生效」此前没有自动化用例。
 * 这里覆盖的是核心层 scanSource 的回调契约；主进程 scan-job 把它转成 IPC 事件的那一段
 * 需要 Electron 运行时（见 vitest.config.mts 的说明），不在本用例范围内。
 */

const ACCOUNT = '1000000001'
let root: string

function addScreenshot(appId: string, fileName: string, content: string): void {
  const dir = join(root, 'userdata', ACCOUNT, '760', 'remote', appId, 'screenshots')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), content)
}

function scan(overrides: Partial<ScanRequest> = {}) {
  return scanSource({ rootPath: root, sourceId: 'src-test', accountIds: [], ...overrides })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ssm-progress-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('扫描进度形状', () => {
  it('先推送总量未知的枚举事件，不伪造百分比', async () => {
    addScreenshot('438100', 'a.jpg', 'a')
    const events: ScanProgress[] = []

    await scan({ onProgress: (progress) => events.push(progress) })

    expect(events[0]).toEqual({
      phase: 'enumerating',
      processed: 0,
      total: null,
      currentFile: null,
      failed: 0
    })
  })

  it('枚举完成后按文件推送已处理数递增、总量确定的进度', async () => {
    addScreenshot('438100', 'a.jpg', 'a')
    addScreenshot('438100', 'b.jpg', 'b')
    addScreenshot('570', 'c.jpg', 'c')
    const events: ScanProgress[] = []

    const outcome = await scan({ onProgress: (progress) => events.push(progress) })

    const hashing = events.filter((event) => event.phase === 'hashing')
    expect(hashing.map((event) => event.processed)).toEqual([1, 2, 3])
    for (const event of hashing) {
      expect(event.total).toBe(3)
      expect(event.currentFile).toContain('/screenshots/')
      expect(event.failed).toBe(0)
    }
    expect(outcome.cancelled).toBe(false)
    expect(outcome.candidates).toHaveLength(3)
  })
})

describe('取消在文件之间生效', () => {
  it('已完成的候选保留，剩余文件不再读取', async () => {
    addScreenshot('438100', 'a.jpg', 'a')
    addScreenshot('438100', 'b.jpg', 'b')
    addScreenshot('438100', 'c.jpg', 'c')
    const events: ScanProgress[] = []
    let hashed = 0

    const outcome = await scan({
      onProgress: (progress) => {
        events.push(progress)
        if (progress.phase === 'hashing') {
          hashed += 1
        }
      },
      shouldCancel: () => hashed >= 1
    })

    expect(outcome.cancelled).toBe(true)
    expect(outcome.candidates).toHaveLength(1)
    expect(events.filter((event) => event.phase === 'hashing')).toHaveLength(1)
  })

  it('未取消时 cancelled 为 false，候选齐全', async () => {
    addScreenshot('438100', 'a.jpg', 'a')
    const outcome = await scan({ shouldCancel: () => false })

    expect(outcome.cancelled).toBe(false)
    expect(outcome.candidates).toHaveLength(1)
  })
})
