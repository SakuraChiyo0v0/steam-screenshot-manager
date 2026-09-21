/**
 * 预览生成队列（主进程）。
 *
 * nativeImage 的解码是同步的，如果在协议请求里直接生成，200 张网格图会让界面卡住。
 * 因此策略是：请求缩略图时**立即**返回可用的图（自建预览 → Steam 缩略图 → 原图），
 * 同时把缺预览的资产放进队列，按固定间隔在后台慢慢补，补好之后下次请求就用预览。
 */

import { generatePreview, hasPreview, type PreviewSize } from '@core/library/previews'
import { resolveExistingAssetPath } from '@core/library/asset-paths'

/** 每张之间留出的间隔：25 张/秒，既能较快补齐又不至于让主进程长时间占用。 */
const RATE_INTERVAL_MS = 40
/** 队列上限，避免一次滚动把几万条塞进内存。 */
const MAX_QUEUE = 2_000

interface QueueItem {
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
        try {
          const sourcePath = await resolveExistingAssetPath(item.sourceRoot, item.relativePath)
          const result = generatePreview({
            libraryRoot: item.libraryRoot,
            sha256: item.sha256,
            sourcePath,
            size: item.size ?? 'preview'
          })
          if (result) {
            this.generated += 1
          } else {
            this.failed += 1
          }
        } catch {
          // 源文件不可读：跳过，不重试（下次请求会重新入队）
          this.failed += 1
        }
        await new Promise((resolve) => setTimeout(resolve, RATE_INTERVAL_MS))
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
