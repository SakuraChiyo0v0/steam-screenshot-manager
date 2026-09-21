/**
 * 预览生成队列（主进程）。
 *
 * nativeImage 的解码是同步的，所以策略要分两种情况：
 *
 * 1. **用户正在看的那几张**：请求量少时直接同步生成（单张解码约 50ms，察觉不到），
 *    这样首屏就是清晰的，而不是先给一张 200px 的 Steam 缩略图。
 * 2. **其余图片**：立即返回可用的小图，同时把缺预览的资产放进队列，
 *    **插到队首**优先处理（可见的图不应该排在两千条预热任务后面），
 *    生成完成后通过 preview:ready 事件让界面自动换成清晰版本。
 *
 * 队列占空比随负载自适应：最近没有图片请求（用户在读、没在翻）就快跑；
 * 有请求在流动就让出时间，保证界面与协议响应不被拖住。
 */

import { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '@shared/ipc'
import { generatePreview, hasPreview, type PreviewSize } from '@core/library/previews'
import { resolveExistingAssetPath } from '@core/library/asset-paths'


/** 空闲判定：这么久没有图片请求就认为用户没在翻页，可以快跑。 */
const IDLE_AFTER_MS = 2_000
/** 有请求在流动时的占空比：忙 x 毫秒让出 x 毫秒。 */
const BUSY_DUTY_RATIO = 1
/** 空闲时最多连续解码多少张后再让出一次。 */
const IDLE_BATCH = 12
/** 队列上限，避免一次滚动把几万条塞进内存。 */
const MAX_QUEUE = 2_000

export interface PreviewTask {
  readonly assetId: string
  readonly cacheRoot: string
  readonly sha256: string
  readonly sourceRoot: string
  readonly relativePath: string
  readonly size?: PreviewSize
}

function broadcastPreviewReady(payload: { assetId: string; size: PreviewSize }): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_EVENTS.previewReady, payload)
    }
  }
}

class PreviewQueue {
  /** 高优先级（用户正在看）与普通（后台预热）两段，高优先级先出。 */
  private readonly priority: PreviewTask[] = []
  private readonly background = new Map<string, PreviewTask>()
  private running = false
  private lastRequestAt = 0
  private generated = 0
  private failed = 0

  private keyOf(task: PreviewTask): string {
    return `${task.cacheRoot}|${task.sha256}|${task.size ?? 'preview'}`
  }

  /** 标记有图片请求到达（用于判断用户是否在浏览）。 */
  noteRequest(): void {
    this.lastRequestAt = Date.now()
  }


  enqueue(task: PreviewTask, front = false): void {
    const size = task.size ?? 'preview'
    if (hasPreview(task.cacheRoot, task.sha256, size)) {
      return
    }
    const key = this.keyOf(task)
    if (front) {
      if (this.priority.length >= MAX_QUEUE) {
        return
      }
      if (!this.priority.some((item) => this.keyOf(item) === key)) {
        this.priority.push(task)
      }
      void this.drain()
      return
    }
    if (this.background.size >= MAX_QUEUE || this.background.has(key)) {
      return
    }
    this.background.set(key, task)
    void this.drain()
  }

  private next(): { task: PreviewTask; fromPriority: boolean } | null {
    const priorityTask = this.priority.shift()
    if (priorityTask) {
      return { task: priorityTask, fromPriority: true }
    }
    const entry = this.background.entries().next()
    if (entry.done) {
      return null
    }
    this.background.delete(entry.value[0])
    return { task: entry.value[1], fromPriority: false }
  }

  /** 后台预热：批量入队（顺序即用户大致会看到的顺序）。 */
  enqueueBackground(tasks: readonly PreviewTask[]): void {
    for (const task of tasks) {
      this.enqueue(task, false)
    }
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      for (;;) {
        const next = this.next()
        if (!next) {
          break
        }
        const task = next.task
        const size = task.size ?? 'preview'
        let busyMs = 0
        try {
          const sourcePath = await resolveExistingAssetPath(task.sourceRoot, task.relativePath)
          const startedAt = Date.now()
          const result = generatePreview({
            cacheRoot: task.cacheRoot,
            sha256: task.sha256,
            sourcePath,
            size
          })
          busyMs = Date.now() - startedAt

          if (result) {
            this.generated += 1
            if (result.created) {
              broadcastPreviewReady({ assetId: task.assetId, size })
              // 顺带把另一个尺寸也从同一张已解码的图生成出来，省一次 4K 解码
              const other: PreviewSize = size === 'preview' ? 'mini' : 'preview'
              if (!hasPreview(task.cacheRoot, task.sha256, other)) {
                generatePreview({
                  cacheRoot: task.cacheRoot,
                  sha256: task.sha256,
                  sourcePath,
                  size: other
                })
              }
            }
          } else {
            this.failed += 1
          }
        } catch {
          this.failed += 1
        }

        // 用户在浏览：让出与解码相当的时间；空闲：连续多张后再让出一次
        const idle = Date.now() - this.lastRequestAt > IDLE_AFTER_MS
        const wait = idle
          ? next.fromPriority
            ? 0
            : Math.floor(busyMs / IDLE_BATCH)
          : Math.min(600, Math.max(40, busyMs * BUSY_DUTY_RATIO))
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait))
        } else {
          await new Promise((resolve) => setImmediate(resolve))
        }
      }
    } finally {
      this.running = false
    }
  }

  stats(): {
    pending: number
    generated: number
    failed: number
    priorityPending: number
  } {
    return {
      pending: this.priority.length + this.background.size,
      generated: this.generated,
      failed: this.failed,
      priorityPending: this.priority.length
    }
  }
}

const queue = new PreviewQueue()

export function notePreviewRequest(): void {
  queue.noteRequest()
}


/** 请求预览（若尚未生成，插到队首后台生成）。 */
export function requestPreview(task: PreviewTask): void {
  queue.enqueue(task, true)
}

/** 后台批量预热（例如归档结束后）。 */
export function requestPreviewWarmup(tasks: readonly PreviewTask[]): void {
  queue.enqueueBackground(tasks)
}

export function previewQueueStats(): {
  pending: number
  generated: number
  failed: number
  priorityPending: number
} {
  return queue.stats()
}
