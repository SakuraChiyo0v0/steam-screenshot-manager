import { useCallback, useEffect, useState } from 'react'
import { ArrowsClockwiseIcon, PauseIcon } from '@phosphor-icons/react'
import { describeError } from '@shared/messages'
import type { JobSummaryDto } from '@shared/types'
import { call } from './api'

/**
 * 任务条。
 *
 * 扫描 / 归档 / 备份 / 恢复以前各有一个进度条、各有一个取消按钮，分散在三个页面里：
 * 想知道"还有没有活没干完"得来回翻。这里把它们收成一条：在跑的都列出来，进度和取消都在同一处。
 */
export function JobCenter({ onFinished }: { onFinished?: () => void }) {
  const [jobs, setJobs] = useState<JobSummaryDto[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const list = await call((api) => api.listJobs())
      setJobs(list)
      return list
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    let alive = true
    let wasRunning = false

    const tick = async () => {
      const list = await refresh()
      if (!alive) return
      const running = list.some((job) => job.running)
      // 从"有任务在跑"变成"没有"时，通知页面刷新一次数据
      if (wasRunning && !running) onFinished?.()
      wasRunning = running
    }

    void tick()
    const timer = setInterval(() => void tick(), 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [onFinished, refresh])

  const visible = jobs.filter((job) => job.running || (job.errorMessage && !job.running))
  if (visible.length === 0) {
    return null
  }

  const stop = async (id: string) => {
    setBusy(true)
    try {
      setJobs(await call((api) => api.cancelJob({ id })))
    } catch {
      // 取消失败不额外提示：下一次轮询会带回真实状态
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="job-center" aria-label="任务">
      {visible.map((job) => {
        const percent =
          job.total && job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : null
        return (
          <div className={job.running ? 'job-row running' : 'job-row failed'} key={job.id}>
            <span className="job-icon">
              <ArrowsClockwiseIcon size={18} />
            </span>
            <div className="job-main">
              <strong>{job.title}</strong>
              {job.running ? (
                <>
                  <p className="muted">
                    {percent === null ? '正在准备…' : `${percent}% · ${job.processed}/${job.total}`}
                    {job.currentFile ? ` · ${job.currentFile}` : ''}
                  </p>
                  {percent !== null && (
                    <div className="job-bar">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                  )}
                </>
              ) : (
                <p className="muted">{describeError(`${job.errorCode ?? ''}：${job.errorMessage ?? ''}`)}</p>
              )}
            </div>
            {job.running && (
              <button type="button" disabled={busy} onClick={() => void stop(job.id)}>
                <PauseIcon size={15} /> 停止
              </button>
            )}
          </div>
        )
      })}
    </section>
  )
}
