import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, DbHealth, Settings } from '@shared/types'

/**
 * 启动自检面板。
 *
 * 用途只有两个：证明渲染层能通过受限 IPC 拿到应用状态，
 * 以及证明渲染层拿不到 Node 能力（require / process / ipcRenderer）。
 * 这不是产品界面，离线采集与归档阶段 起会被真实页面替换。
 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [health, setHealth] = useState<DbHealth | null>(null)
  const [message, setMessage] = useState('正在读取应用信息…')
  const [boundary, setBoundary] = useState('尚未检测')

  const refresh = useCallback(async () => {
    const infoResult = await window.api.getAppInfo()
    if (infoResult.ok) {
      setInfo(infoResult.data)
      setMessage('')
    } else {
      setMessage(`${infoResult.code}：${infoResult.message}`)
    }

    const settingsResult = await window.api.getSettings()
    if (settingsResult.ok) {
      setSettings(settingsResult.data)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runHealth = useCallback(async () => {
    const result = await window.api.runDbHealth()
    if (result.ok) {
      setHealth(result.data)
      setMessage(`数据库自检通过，累计 ${result.data.totalRows} 条记录`)
    } else {
      setMessage(`${result.code}：${result.message}`)
    }
  }, [])

  const pickLibraryRoot = useCallback(async () => {
    const result = await window.api.pickLibraryRoot()
    if (!result.ok) {
      setMessage(`${result.code}：${result.message}`)
      return
    }
    setSettings((previous) => (previous ? { ...previous, libraryRoot: result.data.root } : previous))
    setMessage(result.data.root ? `已选择图库目录：${result.data.root}` : '已取消选择')
  }, [])

  const toggleAutoCollect = useCallback(async () => {
    if (!settings) {
      return
    }
    const result = await window.api.updateSettings({ autoCollect: !settings.autoCollect })
    if (result.ok) {
      setSettings(result.data)
    } else {
      setMessage(`${result.code}：${result.message}`)
    }
  }, [settings])

  const inspectBoundary = useCallback(() => {
    const scope = window as unknown as Record<string, unknown>
    const hasRequire = typeof scope.require === 'function'
    const hasProcess = typeof scope.process !== 'undefined'
    const api = scope.api as Record<string, unknown> | undefined
    const hasRawInvoke = typeof api?.invoke === 'function'
    setBoundary(
      [
        `require：${hasRequire ? '可用（异常）' : '不可用（符合预期）'}`,
        `process：${hasProcess ? '可用（异常）' : '不可用（符合预期）'}`,
        `ipcRenderer：${hasRawInvoke ? '可直接调用（异常）' : '不可见（符合预期）'}`
      ].join('　|　')
    )
  }, [])

  return (
    <main className="panel">
      <h1>Steam 截图管理器 · 工程基础阶段 工程骨架</h1>
      <p className="hint">
        本页面是 启动自检面板，用来验证受限 IPC 与数据库；不是产品界面。
      </p>

      {message ? <p className="message">{message}</p> : null}

      <section>
        <h2>应用信息</h2>
        {info ? (
          <dl>
            <dt>版本</dt>
            <dd>{info.version}</dd>
            <dt>平台</dt>
            <dd>{info.platform}</dd>
            <dt>数据目录</dt>
            <dd className="path">{info.dataDir}</dd>
            <dt>设备 ID</dt>
            <dd className="path">{info.deviceId}</dd>
            <dt>SQLite 驱动</dt>
            <dd>{info.sqliteDriver}</dd>
            <dt>图库根目录</dt>
            <dd className="path">{info.libraryRoot ?? '未选择'}</dd>
          </dl>
        ) : (
          <p className="hint">读取中…</p>
        )}
      </section>

      <section>
        <h2>操作</h2>
        <div className="actions">
          <button type="button" onClick={() => void runHealth()}>
            数据库自检（写入并读回）
          </button>
          <button type="button" onClick={() => void pickLibraryRoot()}>
            选择图库根目录
          </button>
          <button type="button" onClick={() => void toggleAutoCollect()}>
            切换自动收集（占位项）
          </button>
          <button type="button" onClick={inspectBoundary}>
            检测渲染层能力边界
          </button>
          <button type="button" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        <p className="hint">自动收集：{settings ? (settings.autoCollect ? '已开启' : '已关闭') : '读取中…'}</p>
        <p className="boundary">{boundary}</p>
        {health ? (
          <p className="hint">
            最近写入 {health.writtenAt}，读回 {health.readBack.slice(0, 8)}…，累计 {health.totalRows} 条
          </p>
        ) : null}
      </section>
    </main>
  )
}
