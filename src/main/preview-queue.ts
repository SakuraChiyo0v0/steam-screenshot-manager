/**
 * 预览生成队列（主进程）。
 *
 * nativeImage 的解码是同步的，如果在协议请求里直接生成，200 张网格图会让界面卡住。
 * 因此策略是：请求缩略图时**立即**返回可用的图（自建预览 → Steam 缩略图 → 原图），
 * 同时把缺预览的资产放进队列，按固定间隔在后台慢慢补，补好之后下次请求就用预览。
 */

import { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '@shared/ipc'
import { generatePreview, hasPreview, type PreviewSize } from '@core/library/previews'

/** 通知渲染层：这张图的预览已经可用，可以换成它。 */
function broadcastPreviewReady(payload: { assetId: string; size: PreviewSize }): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_EVENTS.previewReady, payload)
    }
  }
}
import { resolveExistingAssetPath } from '@core/library/asset-paths'

/**
 * 占空比：nativeImage 解码是同步的，如果按固定 40ms 间隔跑，
 * 单张解码往往要 50-100ms，队列会几乎不让出主线程，
 * 连协议响应都被拖住（实测表现为图片一直加载不出来）。
 * 因此按实测解码耗时自适应：忙 x 毫秒就让出 x 毫秒（约 50% 占用）。
 */
const DUTY_CYCLE_RATIO = 1
const MIN_INTERVAL_MS = 40
const MAX_INTERVAL_MS = 600
/** 队列上限，避免一次滚动把几万条塞进内存。 */
const MAX_QUEUE = 2_000

interface QueueItem {
  readonly assetId: string
  readonly libraryRoot: string
  readonly sha256: string
  readonly sourceRoot: string
  readonly relativePath: string
  readonly size?: PreviewSize
}

class PreviewQueue {
  private readonly pending = new Map<string, QueueItem>()
  private running = false
  private generated = 0
  private failed = 0

  enqueue(item: QueueItem): void {
    const size = item.size ?? 'preview'
    const key = `${item.libraryRoot}|${item.sha256}|${size}`
    if (this.pending.has(key) || hasPreview(item.libraryRoot, item.sha256, size)) {
      return
    }
    if (this.pending.size >= MAX_QUEUE) {
      return
    }
    this.pending.set(key, item)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      for (;;) {
        const next = this.pending.entries().next()
        if (next.done) {
          break
        }
        const [key, item] = next.value
        this.pending.delete(key)
        let busyMs = 0
        try {
          const sourcePath = await resolveExistingAssetPath(item.sourceRoot, item.relativePath)
          const startedAt = Date.now()
          const result = generatePreview({
            libraryRoot: item.libraryRoot,
            sha256: item.sha256,
            sourcePath,
            size: item.size ?? 'preview'
          })
          busyMs = Date.now() - startedAt
          if (result) {
            this.generated += 1
            if (result.created) {
              broadcastPreviewReady({
                assetId: item.assetId,
                size: item.size ?? 'preview'
              })
            }
          } else {
            this.failed += 1
          }
        } catch {
          // 源文件不可读：跳过，不重试（下次请求会重新入队）
          this.failed += 1
        }
        const wait = Math.min(
          MAX_INTERVAL_MS,
          Math.max(MIN_INTERVAL_MS, busyMs * DUTY_CYCLE_RATIO)
        )
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    } finally {
      this.running = false
    }
  }

  stats(): { pending: number; generated: number; failed: number } {
    return { pending: this.pending.size, generated: this.generated, failed: this.failed }
  }
}

const queue = new PreviewQueue()

/** 请求预览（若尚未生成，排队后台生成）。 */
export function requestPreview(item: QueueItem): void {
  queue.enqueue(item)
}

export function previewQueueStats(): { pending: number; generated: number; failed: number } {
  return queue.stats()
}
