import { useEffect, useState } from 'react'
import type { GalleryGameDto } from '@shared/types'
import type { SteamScreenshotPreview, SteamScreenshotState, SteamScreenshotTarget } from '@shared/steam-screenshot'
import { call, getApi } from './api'

/**
 * 第 2 步：本机临时副本 → Steam。
 *
 * 和「取回原图」分开：那个把原图取回本机，这个把原图写回 Steam 的截图列表。
 * 两件事的失败后果完全不同（前者只是本地文件，后者会动 Steam 的索引并且要能在退出 Steam 后回滚）。
 */
export function LibraryToSteam({ onDone }: { onDone?: () => void }) {
  const [targets, setTargets] = useState<SteamScreenshotTarget[]>([])
  const [games, setGames] = useState<GalleryGameDto[]>([])
  const [targetId, setTargetId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<SteamScreenshotPreview | null>(null)
  const [state, setState] = useState<SteamScreenshotState | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const target = targets.find((item) => item.id === targetId)

  const refresh = async (): Promise<void> => {
    const [choices, library, status] = await Promise.all([
      call((api) => api.getSteamScreenshotTargets()),
      call((api) => api.listGames({})),
      call((api) => api.getSteamScreenshotState())
    ])
    setTargets(choices)
    setGames(library)
    setState(status)
    if (!targetId && choices[0]) {
      setTargetId(choices[0].id)
      setAccountId(choices[0].accounts[0]?.accountId ?? '')
    }
  }

  useEffect(() => {
    if (!getApi()) return
    void refresh().catch((error) => setMessage(String(error)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!state?.running) return
    const timer = setInterval(() => {
      void call((api) => api.getSteamScreenshotState()).then(setState).catch(() => {})
    }, 1000)
    return () => clearInterval(timer)
  }, [state?.running])

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      await work()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      void call((api) => api.getSteamScreenshotState()).then(setState).catch(() => {})
    }
  }

  if (!getApi()) {
    return null
  }

  const disabled = busy || state?.running === true

  return (
    <section className="settings-card direction-card">
      <div className="section-heading">
        <div>
          <h2>
            <span className="dir-badge from">第 2 步</span>
            <span className="dir-arrow">→</span>
            <span className="dir-badge to">写回 Steam</span>
          </h2>
          <p>把本机已有的原图写回 Steam 的本地截图列表。执行前要把 Steam 完全退出。</p>
        </div>
      </div>
      <p className="panel-note">
        只处理同一账号的 JPEG 截图；缺少 Steam 原始登记时会重建，社区上传状态不会被恢复。
      </p>

      <fieldset disabled={disabled} className="steam-restore-fields">
        {targets.length === 0 && (
          <p className="panel-note">没找到本机的 Steam，请先安装并登录；网络共享目录不能作为恢复目标。</p>
        )}
        <div className="form-grid">
          <label>
            Steam 安装目录
            <select
              value={targetId}
              onChange={(event) => {
                const id = event.target.value
                setTargetId(id)
                setAccountId(targets.find((item) => item.id === id)?.accounts[0]?.accountId ?? '')
                setPreview(null)
              }}
            >
              <option value="">请选择本机 Steam</option>
              {targets.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            目标账号
            <select
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value)
                setPreview(null)
              }}
            >
              <option value="">请选择账号</option>
              {target?.accounts.map((account) => (
                <option value={account.accountId} key={account.accountId}>
                  {account.label}（{account.accountId}）
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="form-footer">
          <span>选择要写回的游戏；只处理这个账号在本机有原图的截图。</span>
          <button type="button" onClick={() => { setSelected(games.map((game) => game.gameKey)); setPreview(null) }}>
            全选
          </button>
        </div>

        <div className="toggle-list steam-restore-game-list">
          {games.map((game) => (
            <label className="toggle-row" key={game.gameKey}>
              <input
                type="checkbox"
                checked={selected.includes(game.gameKey)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...new Set([...selected, game.gameKey])]
                      : selected.filter((key) => key !== game.gameKey)
                  )
                }
              />
              <span>{game.name}</span>
            </label>
          ))}
        </div>
        {games.length === 0 && <p className="panel-note">本机还没有可写回的截图：先在上面「取回原图」。</p>}

        <div className="actions">
          <button type="button" onClick={() => void run(refresh)}>
            刷新
          </button>
          <button
            type="button"
            disabled={!targetId || !accountId || selected.length === 0}
            onClick={() =>
              void run(async () => {
                setPreview(
                  await call((api) =>
                    api.previewSteamScreenshots({ targetId, accountId, gameKeys: selected })
                  )
                )
              })
            }
          >
            预览要写回什么
          </button>
        </div>
      </fieldset>

      {preview && (
        <div className="steam-restore-preview">
          <p>
            共 {preview.total} 张 · 待恢复 {preview.added} · 已有 {preview.skipped} · 冲突{' '}
            {preview.conflicts} · 不支持 {preview.unsupported} · 重建登记 {preview.rebuilt}
          </p>
          <details>
            <summary>查看逐张计划</summary>
            {preview.details.length > 200 && <p>只显示前 200 项；执行范围仍是全部所选图片。</p>}
            <ul>
              {preview.details.slice(0, 200).map((item, index) => (
                <li key={index}>
                  {item.game} · {item.filename} · {item.action}
                </li>
              ))}
            </ul>
          </details>
          <div className="form-footer">
            <span>执行前会备份 Steam 原索引；同名但内容不同的会跳过。</span>
            <button
              className="primary"
              disabled={disabled || preview.added === 0}
              onClick={() =>
                void run(async () => {
                  const result = await call((api) => api.restoreSteamScreenshots({ planId: preview.planId }))
                  setPreview(null)
                  setMessage(
                    result.cancelled
                      ? '已取消，并回滚了本次写入。'
                      : `写回完成：${result.restored} 张。启动 Steam 就能在截图列表里看到。`
                  )
                  onDone?.()
                })
              }
            >
              退出 Steam 后开始写回
            </button>
          </div>
        </div>
      )}

      {state?.running && (
        <div className="form-footer" role="status">
          <span>
            正在处理 {state.processed} / {state.total}
          </span>
          <button onClick={() => void call((api) => api.cancelSteamScreenshots()).catch(() => {})}>
            取消并回滚
          </button>
        </div>
      )}
      {busy && !state?.running && <p role="status">正在处理，请稍候…</p>}
      {message && <p className="panel-note">{message}</p>}
      {state?.error && state.error !== message && <p role="alert">{state.error}</p>}

      {!!state?.backups.length && (
        <details>
          <summary>历史与回滚</summary>
          <p className="panel-note">
            只能撤销内容仍与本任务一致的写回；如果 Steam 或其他程序改过索引，会停止回滚并保留备份。
          </p>
          <ul>
            {state.backups.map((backup) => (
              <li key={backup.jobId}>
                <span>
                  {new Date(backup.createdAt).toLocaleString()} ·{' '}
                  {backup.status === 'applied'
                    ? '已写回'
                    : backup.status === 'rolled-back'
                      ? '已回滚'
                      : '未完成，需处理'}
                </span>
                {backup.status !== 'rolled-back' && (
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void run(async () => {
                        await call((api) => api.undoSteamScreenshots({ jobId: backup.jobId }))
                        setPreview(null)
                        setMessage('已回滚，Steam 原有内容保持不变。')
                      })
                    }
                  >
                    退出 Steam 后回滚
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
