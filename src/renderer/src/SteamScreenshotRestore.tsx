import { useEffect, useState } from 'react'
import type { GalleryGameDto, RemoteCatalogDto, RestoreStatusDto } from '@shared/types'
import type { SteamScreenshotPreview, SteamScreenshotState, SteamScreenshotTarget } from '@shared/steam-screenshot'
import { call, getApi } from './api'

export function SteamScreenshotRestore(): React.JSX.Element {
  const [targets, setTargets] = useState<SteamScreenshotTarget[]>([])
  const [games, setGames] = useState<GalleryGameDto[]>([])
  const [targetId, setTargetId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<SteamScreenshotPreview | null>(null)
  const [state, setState] = useState<SteamScreenshotState | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [catalog, setCatalog] = useState<RemoteCatalogDto | null>(null)
  const [libraryRestore, setLibraryRestore] = useState<RestoreStatusDto | null>(null)
  const target = targets.find(item => item.id === targetId)
  const refresh = async (): Promise<void> => {
    const [choices, library, status] = await Promise.all([
      call(api => api.getSteamScreenshotTargets()), call(api => api.listGames({})), call(api => api.getSteamScreenshotState())
    ])
    setTargets(choices); setGames(library); setState(status)
    if (!targetId && choices[0]) { setTargetId(choices[0].id); setAccountId(choices[0].accounts[0]?.accountId ?? '') }
  }
  useEffect(() => {
    if (getApi()) void refresh().catch(error => setMessage(String(error)))
  }, [])
  useEffect(() => {
    if (!busy && !state?.running) return
    const timer = setInterval(() => {
      void call(api => api.getSteamScreenshotState()).then(setState).catch(error => setMessage(String(error)))
      void call(api => api.getRestoreStatus()).then(setLibraryRestore).catch(() => {})
    }, 1000)
    return () => clearInterval(timer)
  }, [busy, state?.running])
  const action = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true); setMessage('')
    try { await run() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false); void call(api => api.getSteamScreenshotState()).then(setState).catch(() => {}) }
  }
  return <section className="settings-card">
    <div className="section-heading"><div><h2>恢复到 Steam</h2><p>把独立图库中的原图恢复到 Steam 本地截图列表。先从远端恢复到图库，或将来源归档，再在这里选择。</p></div></div>
    <p className="panel-note">目前支持本机同账号的 JPEG 截图。缺少 Steam 原始登记信息时重建；不恢复社区上传状态。执行和回滚前请完全退出 Steam。</p>
    {!getApi() ? <p>需要桌面环境。</p> : <>
      <div className="form-footer"><span>远端原图尚未在本机时，先恢复到独立图库。</span><button disabled={busy || state?.running} onClick={() => void action(async () => { setCatalog(await call(api => api.scanRemoteCatalog())) })}>读取远端可恢复游戏</button></div>
      {catalog && <div><p className="panel-note">远端有效记录 {catalog.records} 份{catalog.invalidRecords ? ` · 无效记录 ${catalog.invalidRecords}` : ''}</p>
        <fieldset disabled={busy || state?.running} className="steam-restore-fields"><div className="toggle-list steam-restore-game-list">{catalog.games.map(game => <label className="toggle-row" key={game.gameKey}><input type="checkbox" checked={selected.includes(game.gameKey)} onChange={event => { setSelected(event.target.checked ? [...new Set([...selected, game.gameKey])] : selected.filter(key => key !== game.gameKey)); setPreview(null) }}/><span>{game.gameName} · {game.assets} 张</span></label>)}</div></fieldset>
        <button disabled={busy || state?.running || selected.length === 0} onClick={() => void action(async () => {
          const result = await call(api => api.startRestore({ gameKeys: selected })); await refresh(); setPreview(null)
          setMessage(`图库恢复：${result.restored} 张，跳过 ${result.skipped}，失败 ${result.failed}。${result.failed ? '请先检查图库恢复失败项。' : '现在可以预览恢复到 Steam。'}`)
        })}>将所选远端游戏恢复到独立图库</button>
      </div>}
      {libraryRestore?.running && <p role="status">正在恢复图库：{libraryRestore.processed} / {libraryRestore.total ?? '统计中'}</p>}
      <fieldset disabled={busy || state?.running} className="steam-restore-fields">
        {targets.length === 0 && <p className="panel-note">未发现本机 Steam，请先在本机安装并登录。网络共享目录不作为恢复目标。</p>}
        <div className="form-grid">
          <label>Steam 安装目录<select value={targetId} onChange={event => {
            const id = event.target.value; setTargetId(id); setAccountId(targets.find(item => item.id === id)?.accounts[0]?.accountId ?? ''); setPreview(null)
          }}><option value="">请选择本机 Steam</option>{targets.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
          <label>目标账号<select value={accountId} onChange={event => { setAccountId(event.target.value); setPreview(null) }}><option value="">请选择账号</option>{target?.accounts.map(account => <option value={account.accountId} key={account.accountId}>{account.label}（{account.accountId}）</option>)}</select></label>
        </div>
        <div className="form-footer"><span>选择要恢复的游戏；仅处理这个账号已在独立图库中的副本。</span><button type="button" onClick={() => { setSelected(games.map(game => game.gameKey)); setPreview(null) }}>全选</button></div>
        <div className="toggle-list steam-restore-game-list">{games.map(game => <label className="toggle-row" key={game.gameKey}><input type="checkbox" checked={selected.includes(game.gameKey)} onChange={event => { setSelected(event.target.checked ? [...selected, game.gameKey] : selected.filter(key => key !== game.gameKey)); setPreview(null) }}/><span>{game.name}</span></label>)}</div>
        {games.length === 0 && <p className="panel-note">图库暂无截图，请先归档或从远端恢复。</p>}
        <div className="actions"><button type="button" onClick={() => void action(refresh)}>刷新</button><button type="button" disabled={!targetId || !accountId || selected.length === 0} onClick={() => void action(async () => { setPreview(await call(api => api.previewSteamScreenshots({ targetId, accountId, gameKeys: selected }))) })}>预览恢复内容</button></div>
      </fieldset>
      {preview && <div className="steam-restore-preview"><p>共 {preview.total} 张 · 待恢复 {preview.added} · 已有 {preview.skipped} · 冲突 {preview.conflicts} · 不支持 {preview.unsupported} · 重建登记 {preview.rebuilt}</p>
        <details><summary>查看逐张计划</summary>{preview.details.length > 200 && <p>显示前 200 项；上面的数量与执行范围包含全部所选图片。</p>}<ul>{preview.details.slice(0, 200).map((item, index) => <li key={index}>{item.game} · {item.filename} · {item.action}</li>)}</ul></details>
        <div className="form-footer"><span>会备份原索引，保留已有内容；冲突项跳过。</span><button className="primary" disabled={busy || state?.running || preview.added === 0} onClick={() => void action(async () => {
          const result = await call(api => api.restoreSteamScreenshots({ planId: preview.planId })); setPreview(null)
          setMessage(result.cancelled ? '已取消并回滚本次新增内容。' : `恢复写入完成：${result.restored} 张。请启动 Steam 查看本地截图列表。`)
        })}>退出 Steam 后，开始恢复</button></div>
      </div>}
      {state?.running && <div className="form-footer" role="status"><span>正在处理 {state.processed} / {state.total}</span><button onClick={() => void call(api => api.cancelSteamScreenshots()).catch(error => setMessage(String(error)))}>取消并回滚</button></div>}
      {busy && !state?.running && <p role="status">正在处理，请稍候…</p>}
      {message && <p role="status" className="panel-note">{message}</p>}
      {state?.error && state.error !== message && <p role="alert">{state.error}</p>}
      {!!state?.backups.length && <details><summary>恢复备份与回滚</summary><p>只能撤销内容仍与本任务一致的恢复；Steam 或其他程序修改过索引时会停止回滚，保留备份。</p><ul>{state.backups.map(backup => <li key={backup.jobId}><span>{new Date(backup.createdAt).toLocaleString()} · {backup.status === 'applied' ? '已恢复' : backup.status === 'rolled-back' ? '已回滚' : '未完成，需处理'}</span>{backup.status !== 'rolled-back' && <button disabled={busy || state.running} onClick={() => void action(async () => { await call(api => api.undoSteamScreenshots({ jobId: backup.jobId })); setPreview(null); setMessage('本次恢复已回滚，原有内容保持不变。') })}>退出 Steam 后回滚</button>}</li>)}</ul></details>}
    </>}
  </section>
}
