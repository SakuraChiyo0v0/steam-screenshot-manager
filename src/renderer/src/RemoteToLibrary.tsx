import { useEffect, useState } from 'react'
import type { RemoteCatalogDto, RestoreStatusDto } from '@shared/types'
import { call, getApi } from './api'

/**
 * 第 1 步：备份地址 → 本机临时副本。
 *
 * 单独成一个区块：以前它和「写回 Steam」挤在同一张卡里，
 * 两个方向用同一组按钮，很容易点错。这里只做"把远端的原图搬回本机"。
 */
export function RemoteToLibrary({ onDone }: { onDone?: () => void }) {
  const [catalog, setCatalog] = useState<RemoteCatalogDto | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [status, setStatus] = useState<RestoreStatusDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!getApi()) return
    void call((api) => api.getRestoreStatus()).then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    if (!status?.running) return
    const timer = setInterval(() => {
      void call((api) => api.getRestoreStatus()).then(setStatus).catch(() => {})
    }, 1000)
    return () => clearInterval(timer)
  }, [status?.running])

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      await work()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      void call((api) => api.getRestoreStatus()).then(setStatus).catch(() => {})
    }
  }

  if (!getApi()) {
    return null
  }

  return (
    <section className="settings-card direction-card">
      <div className="section-heading">
        <div>
          <h2>
            <span className="dir-badge from">备份地址</span>
            <span className="dir-arrow">→</span>
            <span className="dir-badge to">Steam</span>
          </h2>
          <p>换电脑或重装后，从备份里把原图恢复到 Steam：第 1 步取回原图，第 2 步写回 Steam。</p>
        </div>
      </div>

      <div className="form-footer">
        <span>{catalog ? `远端有 ${catalog.records} 份有效记录` : '先读一次远端清单，才知道有哪些游戏可以取回。'}</span>
        <button
          disabled={busy || status?.running}
          onClick={() =>
            void run(async () => {
              const next = await call((api) => api.scanRemoteCatalog())
              setCatalog(next)
              setSelected([])
            })
          }
        >
          读取远端清单
        </button>
      </div>

      {catalog && (
        <>
          {(catalog.invalidRecords ?? 0) > 0 && (
            <p className="panel-note">有 {catalog.invalidRecords} 份记录读不懂，已跳过。</p>
          )}
          {catalog.games.length === 0 ? (
            <p className="panel-note">远端还没有可恢复的游戏。</p>
          ) : (
            <>
              <div className="toggle-list steam-restore-game-list">
                {catalog.games.map((game) => (
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
                    <span>
                      {game.gameName} · {game.assets} 张
                    </span>
                  </label>
                ))}
              </div>
              <div className="form-footer">
                <span>只取回勾选的游戏；已经在本机的会跳过。</span>
                <div className="actions">
                  <button type="button" onClick={() => setSelected(catalog.games.map((game) => game.gameKey))}>
                    全选
                  </button>
                  <button
                    className="primary"
                    disabled={busy || status?.running || selected.length === 0}
                    onClick={() =>
                      void run(async () => {
                        const result = await call((api) => api.startRestore({ gameKeys: selected }))
                        setMessage(
                          `取回完成：${result.restored} 张，跳过 ${result.skipped}，失败 ${result.failed}。${
                            result.failed ? '失败项可以再点一次重试。' : '现在可以在下面恢复到 Steam。'
                          }`
                        )
                        onDone?.()
                      })
                    }
                  >
                    第 1 步：取回原图
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {status?.running && (
        <div className="form-footer" role="status">
          <span>
            正在取回：{status.processed} / {status.total ?? '统计中'}
            {status.currentFile ? ` · ${status.currentFile}` : ''}
          </span>
          <button onClick={() => void call((api) => api.cancelRestore()).catch(() => {})}>停止</button>
        </div>
      )}
      {message && <p className="panel-note">{message}</p>}
    </section>
  )
}
