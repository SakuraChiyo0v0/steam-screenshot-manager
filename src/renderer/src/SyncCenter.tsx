import { useCallback, useEffect, useState } from 'react'
import { ArrowClockwiseIcon, CheckCircleIcon, CloudArrowUpIcon, GameControllerIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { describeError } from '@shared/messages'
import type { JobSummaryDto, RemoteTargetDto, SyncStepDto, SyncSummaryDto } from '@shared/types'
import { call, getApi } from './api'

/**
 * 同步中心。
 *
 * 只回答两个问题：
 *   1. 我 Steam 里的截图，备份出去了吗？
 *   2. 这台新机器上，怎么把备份里的图搬回 Steam？
 *
 * 中间那些「归档 / 图库 / 账本」的概念都藏起来：同步就是"取并集"——
 * 有新截图就推到所有备份地址，本机删了东西也不会去删备份。
 */
export function SyncCenter() {
  const [summary, setSummary] = useState<SyncSummaryDto | null>(null)
  const [targets, setTargets] = useState<RemoteTargetDto[]>([])
  const [jobs, setJobs] = useState<JobSummaryDto[]>([])
  const [running, setRunning] = useState(false)
  const [note, setNote] = useState('')
  const [steps, setSteps] = useState<readonly SyncStepDto[]>([])
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!getApi()) return
    const [nextSummary, nextTargets] = await Promise.all([
      call((api) => api.getSyncSummary()),
      call((api) => api.listRemoteTargets())
    ])
    setSummary(nextSummary)
    setTargets(nextTargets)
  }, [])

  useEffect(() => {
    void refresh().catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
  }, [refresh])

  // 任务进度：扫描/备份在跑时按钮置灰，结束后刷新数字
  useEffect(() => {
    if (!getApi()) return
    let wasRunning = false
    const tick = async () => {
      try {
        const list = await call((api) => api.listJobs())
        setJobs(list)
        const busy = list.some((job) => job.running && (job.id === 'scan' || job.id === 'upload' || job.id === 'restore'))
        setRunning(busy)
        if (wasRunning && !busy) {
          // 跑完了：取这一轮的结果并刷新数字
          void call((api) => api.getSyncAllState())
            .then((state) => {
              if (!state) return
              setSteps(state.steps)
              setNote(
                `推出去 ${state.backedUp} 张 · 取回来 ${state.pulled} 张 · ${
                  state.writtenBack < 0 ? '写回 Steam：跳过' : `写回 Steam ${state.writtenBack} 张`
                }`
              )
              const bad = state.steps.filter((step) => !step.ok)
              setError(bad.length > 0 ? bad.map((step) => step.detail).join('；') : '')
            })
            .catch(() => {})
          void refresh()
        }
        wasRunning = busy
      } catch {
        // 忽略：下一轮再看
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1200)
    return () => clearInterval(timer)
  }, [refresh])

  const startSync = async () => {
    setError('')
    setNote('')
    setSteps([])
    try {
      // 后端立即返回，真正的活交给后台；界面靠任务状态自动更新
      const ack = await call((api) => api.syncAll())
      if (!ack.started) {
        setError(ack.error ?? '同步没能启动')
        return
      }
      setNote('已开始同步，进度看上面的任务条')
    } catch (failure) {
      setError(describeError(failure instanceof Error ? failure.message : String(failure)))
    }
  }

  const scanJob = jobs.find((job) => job.id === 'scan' && job.running)
  const uploadJob = jobs.find((job) => job.id === 'upload' && job.running)
  const progress = scanJob
    ? { title: '正在读取 Steam 截图', job: scanJob }
    : uploadJob
      ? { title: '正在备份', job: uploadJob }
      : null

  const total = summary?.indexedCount ?? 0
  const addressCount = targets.length

  return (
    <div className="sync-stack">
      <section className="sync-hero">
        <div className="hero-main">
          <div className="hero-line">
            <GameControllerIcon size={26} />
            <strong>Steam 里 {total} 张截图</strong>
          </div>
          <button className="primary hero-button" disabled={running || addressCount === 0} onClick={() => void startSync()}>
            {running ? '正在同步…' : '一键同步（双向）'}
            {!running && <ArrowClockwiseIcon size={18} />}
          </button>
        </div>
        <p className="hero-note">
          {addressCount === 0
            ? '还没有备份地址：先去设置里加一个（本机盘、NAS 共享或 WebDAV 都行）。'
            : `会推到 ${addressCount} 个备份地址，同时把备份里有、本机没有的取回来。只做并集：哪边都不会因为另一边少了而删除。`}
        </p>
        {progress && (
          <p className="hero-progress" role="status">
            {progress.title}
            {progress.job.total
              ? ` · ${progress.job.processed}/${progress.job.total}`
              : ` · 已处理 ${progress.job.processed}`}
            {progress.job.currentFile ? ` · ${progress.job.currentFile}` : ''}
          </p>
        )}
        {note && <p className="hero-ok">{note}</p>}
        {steps.length > 0 && (
          <ul className="sync-steps">
            {steps.map((step) => (
              <li key={step.step} className={step.ok ? 'ok' : 'warn'}>
                {step.ok ? <CheckCircleIcon size={15} weight="fill" /> : <WarningCircleIcon size={15} />}
                <span>
                  {step.step === 'push' ? '推送' : step.step === 'pull' ? '取回' : '写回 Steam'}：
                  {step.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="hero-error">
            <WarningCircleIcon size={16} /> {error}
          </p>
        )}
      </section>

      <section className="settings-card">
        <div className="section-heading">
          <div>
            <h2>备份地址</h2>
            <p>每个地址单独看进度；某个地址取不到只跳过它。</p>
          </div>
          <CloudArrowUpIcon size={23} />
        </div>
        {targets.length === 0 ? (
          <p className="panel-note">还没有地址。去「设置」里添加。</p>
        ) : (
          <div className="target-list">
            {targets.map((target) => {
              const missing = Math.max(0, total - target.verified)
              const ok = target.connected && missing === 0
              return (
                <div className="target-row" key={target.remoteId}>
                  <span className={ok ? 'target-state ok' : 'target-state warn'}>
                    {ok ? <CheckCircleIcon size={17} weight="fill" /> : <WarningCircleIcon size={17} />}
                  </span>
                  <span className="target-kind">{target.kind === 'folder' ? '文件夹' : 'WebDAV'}</span>
                  <span className="target-url" title={target.baseUrl}>
                    {target.baseUrl}
                  </span>
                  <span className="muted small">
                    {!target.connected
                      ? '取不到'
                      : missing === 0
                        ? `已同步 ${target.verified} 张`
                        : `已同步 ${target.verified} · 缺 ${missing}`}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </section>

    </div>
  )
}
