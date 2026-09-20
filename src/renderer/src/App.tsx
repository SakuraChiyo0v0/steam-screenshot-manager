import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ImagesIcon,
  SquaresFourIcon,
  CloudArrowUpIcon,
  GearSixIcon,
  SunIcon,
  MoonIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  FolderOpenIcon,
  XIcon,
  CheckIcon,
  HardDrivesIcon,
  DesktopIcon,
  CaretRightIcon,
  WarningCircleIcon,
  ClockIcon,
  PauseIcon,
  PlayIcon,
  CheckCircleIcon,
  ArrowsClockwiseIcon,
  TrashIcon
} from '@phosphor-icons/react'
import type {
  AccountSummaryDto,
  DiscoveredRootDto,
  GalleryAssetDto,
  GalleryGameDto,
  LibraryStatsDto,
  RegisteredSourceDto,
  ScanProgressDto,
  ScanStatusDto,
  Settings
} from '@shared/types'
import { call, getApi } from './api'
import {
  accountLabel,
  formatBytes,
  toGameCard,
  toViewerItem,
  type GameCard,
  type ViewerItem
} from './view-model'
import { Viewer } from './Viewer'
import { Modal } from './Modal'
import { Diagnostics } from './Diagnostics'

type Page = 'library' | 'all' | 'sync' | 'settings'
type Theme = 'dark' | 'light' | 'system'
type InstalledFilter = 'all' | 'installed' | 'uninstalled'

const nav = [
  { id: 'library', title: '游戏库', icon: SquaresFourIcon },
  { id: 'all', title: '全部截图', icon: ImagesIcon },
  { id: 'sync', title: '同步中心', icon: CloudArrowUpIcon }
] as const

const PAGE_SIZE = 200

function readTheme(): Theme {
  try {
    const value = localStorage.getItem('ssm-ui-theme')
    return value === 'light' || value === 'system' ? value : 'dark'
  } catch {
    return 'dark'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function App() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [systemDark, setSystemDark] = useState(
    matchMedia('(prefers-color-scheme: dark)').matches
  )
  const [page, setPage] = useState<Page>('library')
  const [gameId, setGameId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [accountFilter, setAccountFilter] = useState<string | null>(null)
  const [installedFilter, setInstalledFilter] = useState<InstalledFilter>('all')
  const [sort, setSort] = useState('recent')

  const [accounts, setAccounts] = useState<AccountSummaryDto[]>([])
  const [stats, setStats] = useState<LibraryStatsDto | null>(null)
  const [games, setGames] = useState<GalleryGameDto[]>([])
  const [assets, setAssets] = useState<GalleryAssetDto[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [sources, setSources] = useState<RegisteredSourceDto[]>([])
  const [discovered, setDiscovered] = useState<DiscoveredRootDto[]>([])
  const [scanStatus, setScanStatus] = useState<ScanStatusDto | null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [scanAccounts, setScanAccounts] = useState<string[]>([])
  const [scanSourceId, setScanSourceId] = useState<string | null>(null)

  const [viewer, setViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null)
  const [toast, setToast] = useState('')
  const [syncDemo, setSyncDemo] = useState(false)
  const [paused, setPaused] = useState(false)
  const [syncFilter, setSyncFilter] = useState('全部任务')
  const [diagnostics, setDiagnostics] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)

  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  const hasApi = getApi() !== null
  const installedParam = installedFilter === 'all' ? null : installedFilter === 'installed'
  const assetSort = sort === 'oldest' ? 'captured-asc' : 'captured-desc'

  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const handle = () => setSystemDark(query.matches)
    query.addEventListener('change', handle)
    return () => query.removeEventListener('change', handle)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    try {
      localStorage.setItem('ssm-ui-theme', theme)
    } catch {
      /* 偏好无法保存不影响使用。 */
    }
  }, [theme, resolvedTheme])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 6000)
    return () => clearTimeout(timer)
  }, [toast])

  /** 首屏：账号、统计、来源、扫描状态、本机设置。 */
  useEffect(() => {
    void (async () => {
      if (!hasApi) {
        setLoading(false)
        setLoadError('需要桌面环境：当前没有可用的桌面接口。')
        return
      }
      try {
        const [accountList, stat, sourceList, status, currentSettings] = await Promise.all([
          call((api) => api.listAccounts()),
          call((api) => api.getLibraryStats()),
          call((api) => api.listSources()),
          call((api) => api.getScanStatus()),
          call((api) => api.getSettings())
        ])
        setAccounts(accountList)
        setStats(stat)
        setSources(sourceList)
        setScanStatus(status)
        setSettings(currentSettings)
      } catch (error) {
        setLoadError(errorMessage(error))
      }
    })()
  }, [hasApi])

  /** 扫描进度事件订阅（主进程推送，界面不轮询）。 */
  useEffect(() => {
    const api = getApi()
    if (!api) {
      return
    }
    api.onScanProgress((progress: ScanProgressDto) => {
      setScanStatus((current) => ({
        running: true,
        sourceId: progress.sourceId,
        phase: progress.phase,
        processed: progress.processed,
        total: progress.total,
        currentFile: progress.currentFile,
        failed: progress.failed,
        startedAt: current?.startedAt ?? null,
        finishedAt: null,
        cancelled: false,
        errorCode: null,
        errorMessage: null
      }))
    })
    return () => api.offScanProgress()
  }, [])

  const refreshLibrary = useCallback(async () => {
    if (!hasApi) return
    setLoading(true)
    setLoadError(null)
    try {
      if (page === 'library' && !gameId) {
        const rows = await call((api) =>
          api.listGames({ query: search, installed: installedParam, accountKey: accountFilter })
        )
        setGames(rows)
        setAssets([])
        setNextCursor(null)
      } else {
        const result = await call((api) =>
          api.listAssets({
            gameKey: gameId,
            query: search,
            installed: installedParam,
            accountKey: accountFilter,
            sort: assetSort,
            limit: PAGE_SIZE
          })
        )
        setAssets([...result.items])
        setNextCursor(result.nextCursor)
      }
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [hasApi, page, gameId, search, installedParam, accountFilter, assetSort])

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshLibrary()
    }, 220)
    return () => clearTimeout(timer)
  }, [refreshLibrary])

  const loadMore = useCallback(async () => {
    if (!nextCursor || !hasApi) return
    try {
      const result = await call((api) =>
        api.listAssets({
          gameKey: gameId,
          query: search,
          installed: installedParam,
          accountKey: accountFilter,
          sort: assetSort,
          cursor: nextCursor,
          limit: PAGE_SIZE
        })
      )
      setAssets((current) => [...current, ...result.items])
      setNextCursor(result.nextCursor)
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [nextCursor, hasApi, gameId, search, installedParam, accountFilter, assetSort])

  const refreshMeta = useCallback(async () => {
    if (!hasApi) return
    const [accountList, stat, sourceList, status] = await Promise.all([
      call((api) => api.listAccounts()),
      call((api) => api.getLibraryStats()),
      call((api) => api.listSources()),
      call((api) => api.getScanStatus())
    ])
    setAccounts(accountList)
    setStats(stat)
    setSources(sourceList)
    setScanStatus(status)
  }, [hasApi])

  const navigate = (next: Page) => {
    setPage(next)
    setGameId(null)
    setSearch('')
    setSort('recent')
    setDiagnostics(false)
  }

  const visibleGames = useMemo<GameCard[]>(() => {
    const cards = games.map(toGameCard)
    return sort === 'name' ? [...cards].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) : cards
  }, [games, sort])

  const viewerItems = useMemo(() => assets.map(toViewerItem), [assets])
  const selectedGame = games.find((game) => game.gameKey === gameId) ?? null
  const accountOptions = useMemo(
    () =>
      accounts.map((item) => ({
        key: item.accountKey,
        label: accountLabel(item.accountKey, item.displayName)
      })),
    [accounts]
  )

  const openSources = async () => {
    setSourcesOpen(true)
    if (!hasApi) return
    try {
      const [roots, sourceList] = await Promise.all([
        call((api) => api.discoverSources()),
        call((api) => api.listSources())
      ])
      setDiscovered(roots)
      setSources(sourceList)
      const first = sourceList[0]
      if (first) {
        setScanSourceId((current) => current ?? first.sourceId)
      }
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  const addSource = async () => {
    try {
      const next = await call((api) => api.addSource())
      setSources(next)
      const roots = await call((api) => api.discoverSources())
      setDiscovered(roots)
      if (next[0] && !scanSourceId) {
        setScanSourceId(next[0].sourceId)
      }
      setToast(`已登记 ${next.length} 个来源。`)
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  const removeSource = async (sourceId: string) => {
    try {
      const next = await call((api) => api.removeSource({ sourceId }))
      setSources(next)
      if (scanSourceId === sourceId) {
        setScanSourceId(next[0]?.sourceId ?? null)
      }
      setToast('已移除来源登记；索引中已有的资产会显示为原图缺失。')
      await refreshMeta()
      await refreshLibrary()
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  const startScan = async () => {
    if (!scanSourceId) {
      setToast('请先选择要扫描的来源。')
      return
    }
    setToast('扫描已开始，可以继续浏览界面。')
    try {
      const summary = await call((api) =>
        api.startScan({ sourceId: scanSourceId, accountIds: scanAccounts })
      )
      setToast(
        `扫描完成：来源文件 ${summary.sourceFiles}，新增资产 ${summary.createdAssets}，缺失 ${summary.missingMarked}，失败 ${summary.failures}，耗时 ${(summary.durationMs / 1000).toFixed(1)} 秒${summary.cancelled ? '（已取消）' : ''}。`
      )
      await refreshMeta()
      await refreshLibrary()
    } catch (error) {
      setToast(errorMessage(error))
      await refreshMeta()
    }
  }

  const cancelScan = async () => {
    try {
      const status = await call((api) => api.cancelScan())
      setScanStatus(status)
      setToast('已请求取消，扫描会在当前文件处理完后停止。')
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  const pickLibraryRoot = async () => {
    try {
      const state = await call((api) => api.pickLibraryRoot())
      setSettings((current) => (current ? { ...current, libraryRoot: state.root } : current))
      setToast(state.root ? `已选择图库目录：${state.root}` : '已取消选择。')
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  const selectedScanSource = sources.find((source) => source.sourceId === scanSourceId) ?? null
  const scanRunning = scanStatus?.running === true
  const scanProgressLabel = scanStatus
    ? scanStatus.total === null
      ? `正在统计文件（已发现 ${scanStatus.processed}）`
      : `${scanStatus.processed} / ${scanStatus.total}`
    : ''

  const emptyState = (
    <div className="empty-state">
      <MagnifyingGlassIcon size={42} weight="light" />
      <h2>{loadError ? '无法读取图库' : hasApi ? '这里还没有截图' : '需要桌面环境'}</h2>
      <p>
        {loadError ??
          (hasApi
            ? '先登记 Steam 数据来源并执行一次扫描，索引完成后这里会显示真实截图。'
            : '浏览器预览没有桌面接口，图库与扫描不可用。')}
      </p>
      {hasApi && !loadError ? (
        <button onClick={() => void openSources()}>打开数据来源</button>
      ) : null}
    </div>
  )

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <ImagesIcon size={26} weight="duotone" />
          </span>
          <div>
            <strong>拾光</strong>
            <span>STEAM SCREENSHOTS</span>
          </div>
        </div>
        <div className="sidebar-label">我的收藏</div>
        <nav aria-label="主导航">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => navigate(item.id)}
              title={item.title}
              aria-current={page === item.id ? 'page' : undefined}
            >
              <item.icon size={21} weight={page === item.id ? 'fill' : 'regular'} />
              <span>{item.title}</span>
              {item.id === 'all' && <small>{stats?.assets ?? 0}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="storage-card" onClick={() => navigate('settings')}>
            <CloudArrowUpIcon size={23} />
            <div>
              <strong>让回忆多一份备份</strong>
              <span>连接你的 WebDAV 存储</span>
            </div>
            <CaretRightIcon size={15} />
          </button>
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => navigate('settings')}
            title="设置"
          >
            <GearSixIcon size={21} />
            <span>设置</span>
          </button>
          <div className="sidebar-foot">
            <div className="theme-switch" aria-label="主题">
              <button
                aria-label="日间模式"
                aria-pressed={resolvedTheme === 'light'}
                className={resolvedTheme === 'light' ? 'active' : ''}
                onClick={() => setTheme('light')}
              >
                <SunIcon size={18} />
              </button>
              <button
                aria-label="夜间模式"
                aria-pressed={resolvedTheme === 'dark'}
                className={resolvedTheme === 'dark' ? 'active' : ''}
                onClick={() => setTheme('dark')}
              >
                <MoonIcon size={18} />
              </button>
            </div>
            <span className="preview-tag">本地索引</span>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="page-header">
          <div>
            {selectedGame && (
              <button
                className="back-link"
                onClick={() => {
                  setGameId(null)
                  setSearch('')
                }}
              >
                <ArrowLeftIcon size={16} />
                游戏库
              </button>
            )}
            <h1>
              {selectedGame?.name ??
                {
                  library: '游戏库',
                  all: '全部截图',
                  sync: '同步中心',
                  settings: '设置'
                }[page]}
            </h1>
            <p>
              {selectedGame
                ? `${selectedGame.assetCount} 张截图 · ${formatBytes(selectedGame.bytes)} · ${selectedGame.gameKey}`
                : {
                    library: stats
                      ? `${stats.games} 款游戏 · ${stats.assets} 张截图 · ${formatBytes(stats.bytes)}`
                      : '按游戏收藏，随时重温。',
                    all: '每一个值得留下的瞬间。',
                    sync: '让珍贵的画面，在每台设备上延续。',
                    settings: '按你的习惯，安放每一份回忆。'
                  }[page]}
            </p>
          </div>
          {(page === 'library' || page === 'all') && (
            <button className="primary" onClick={() => void openSources()}>
              <PlusIcon size={19} />
              数据来源
            </button>
          )}
        </header>

        {scanRunning && (
          <div className="connection-banner">
            <span className="connection-icon">
              <ArrowsClockwiseIcon size={26} />
            </span>
            <div>
              <h2>正在扫描来源</h2>
              <p>
                {scanProgressLabel}
                {scanStatus?.failed ? ` · 失败 ${scanStatus.failed}` : ''}
                {scanStatus?.currentFile ? ` · ${scanStatus.currentFile}` : ''}
              </p>
            </div>
            <button onClick={() => void cancelScan()}>取消扫描</button>
          </div>
        )}

        {(page === 'library' || page === 'all') && (
          <>
            <div className="library-toolbar">
              <div className="tabs" aria-label="筛选">
                {page === 'library' && !gameId ? (
                  <>
                    {(
                      [
                        { id: 'all', title: '全部游戏' },
                        { id: 'installed', title: '已安装' },
                        { id: 'uninstalled', title: '已卸载' }
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.id}
                        className={installedFilter === item.id ? 'active' : ''}
                        onClick={() => setInstalledFilter(item.id)}
                      >
                        {item.title}
                        {item.id === 'all' && <small>{games.length}</small>}
                      </button>
                    ))}
                    {accountOptions.map((option) => (
                      <button
                        key={option.key}
                        className={accountFilter === option.key ? 'active' : ''}
                        onClick={() =>
                          setAccountFilter((current) =>
                            current === option.key ? null : option.key
                          )
                        }
                        title={option.key}
                      >
                        {option.label}
                      </button>
                    ))}
                  </>
                ) : (
                  <span className="muted">{assets.length} 张截图</span>
                )}
              </div>
              <div className="search-control">
                <MagnifyingGlassIcon size={18} />
                <input
                  aria-label="搜索游戏或截图"
                  placeholder={page === 'library' && !gameId ? '搜索游戏…' : '搜索截图…'}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <button
                    aria-label="清除搜索"
                    className="icon-button"
                    onClick={() => setSearch('')}
                  >
                    <XIcon size={15} />
                  </button>
                )}
              </div>
            </div>
            <div className="result-toolbar">
              <span>
                {page === 'library' && !gameId
                  ? `${visibleGames.length} 款游戏 · ${visibleGames.reduce((count, game) => count + game.assetCount, 0)} 张截图`
                  : selectedGame
                    ? '游戏相册'
                    : '所有游戏的截图'}
              </span>
              <label className="sort-label">
                排序
                <select
                  aria-label="排序"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="recent">最近拍摄</option>
                  {page === 'library' && !gameId ? (
                    <option value="name">游戏名称</option>
                  ) : (
                    <option value="oldest">最早拍摄</option>
                  )}
                </select>
              </label>
            </div>

            {loading ? (
              <div className="empty-state">
                <ArrowsClockwiseIcon size={42} weight="light" />
                <h2>正在读取索引</h2>
                <p>从本机数据库加载游戏与截图。</p>
              </div>
            ) : page === 'library' && !gameId ? (
              visibleGames.length ? (
                <div className="game-grid">
                  {visibleGames.map((game) => (
                    <button
                      className="game-card"
                      key={game.key}
                      onClick={() => {
                        setGameId(game.key)
                        setSearch('')
                        setSort('recent')
                      }}
                    >
                      <div className="card-image">
                        {game.coverUrl ? (
                          <img src={game.coverUrl} alt={`${game.name} 最近一张截图`} />
                        ) : (
                          <div className="empty-state">
                            <ImagesIcon size={28} weight="light" />
                            <p>暂无可用截图</p>
                          </div>
                        )}
                        <span className="image-count">
                          <ImagesIcon size={14} />
                          {game.assetCount} 张
                        </span>
                        <span className="card-open">
                          <ArrowRightIcon size={20} />
                        </span>
                      </div>
                      <div className="card-body">
                        <h2>{game.name}</h2>
                        <p>{game.keyLabel}</p>
                        <div className="card-meta">
                          <span>{game.installed ? '已安装' : '已卸载'}</span>
                          <span>{game.bytesLabel}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                emptyState
              )
            ) : viewerItems.length ? (
              <>
                <div className="shot-grid">
                  {viewerItems.map((shot, index) => (
                    <button
                      className="shot-card"
                      key={shot.id}
                      onClick={() => setViewer({ items: viewerItems, index })}
                    >
                      <div className="card-image">
                        {shot.available ? (
                          <img src={shot.thumbSrc} alt={shot.title} />
                        ) : (
                          <div className="empty-state">
                            <WarningCircleIcon size={26} weight="light" />
                            <p>原图缺失</p>
                          </div>
                        )}
                        <span className="card-open">
                          <ImagesIcon size={20} />
                        </span>
                      </div>
                      <div className="shot-caption">
                        <strong>{shot.title}</strong>
                        <span>{gameId ? shot.date : shot.gameName}</span>
                      </div>
                    </button>
                  ))}
                </div>
                {nextCursor ? (
                  <div className="result-toolbar">
                    <span className="muted">已加载 {viewerItems.length} 张，还有更多</span>
                    <button onClick={() => void loadMore()}>加载更多</button>
                  </div>
                ) : null}
              </>
            ) : (
              emptyState
            )}
          </>
        )}

        {page === 'sync' && (
          <>
            <div className="connection-banner">
              <span className="connection-icon">
                <CloudArrowUpIcon size={29} />
              </span>
              <div>
                <h2>还没有连接远端存储</h2>
                <p>使用自己的 WebDAV，让截图有处可存。本阶段尚未接入上传。</p>
              </div>
              <button onClick={() => navigate('settings')}>
                配置存储
                <ArrowRightIcon size={17} />
              </button>
            </div>
            <div className="section-heading">
              <h2>传输任务</h2>
              <button className="text-button" onClick={() => setSyncDemo(!syncDemo)}>
                {syncDemo ? '隐藏界面示例' : '查看界面示例'}
              </button>
            </div>
            {!syncDemo ? (
              <div className="empty-state">
                <CloudArrowUpIcon size={56} weight="light" />
                <h2>这里将记录每一次安心备份</h2>
                <p>连接存储后，上传和下载任务会出现在这里。</p>
                <span className="demo-pill">当前仅展示界面，不执行同步</span>
              </div>
            ) : (
              <div className="task-panel">
                <div className="task-toolbar">
                  <div className="tabs">
                    {['全部任务', '待处理', '需重试'].map((item) => (
                      <button
                        className={syncFilter === item ? 'active' : ''}
                        key={item}
                        onClick={() => setSyncFilter(item)}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                  <button onClick={() => setPaused(!paused)}>
                    {paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />}{' '}
                    {paused ? '继续示例' : '暂停示例'}
                  </button>
                </div>
                {viewerItems.slice(0, 3).map((item, i) => (
                  <div className="task-row" key={item.id}>
                    {item.available ? <img src={item.thumbSrc} alt="" /> : <span />}
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.gameName} · 上传任务（界面示例）</span>
                    </div>
                    <span className={`task-state state-${i}`}>
                      {i === 0 ? (
                        <ClockIcon size={17} />
                      ) : i === 1 ? (
                        <WarningCircleIcon size={17} />
                      ) : (
                        <CheckCircleIcon size={17} />
                      )}{' '}
                      {i === 0
                        ? paused
                          ? '已暂停'
                          : '等待上传'
                        : i === 1
                          ? '连接中断'
                          : '已备份（示例）'}
                    </span>
                    {i === 1 && (
                      <button
                        onClick={() => setToast('重试操作预览：未连接 WebDAV，也未发送文件。')}
                      >
                        重试
                      </button>
                    )}
                  </div>
                ))}
                <p className="panel-note">
                  以上为静态界面示例，未发生实际传输，也不代表任何截图已备份。
                </p>
              </div>
            )}
          </>
        )}

        {page === 'settings' && (
          <div className="settings-stack">
            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <h2>外观</h2>
                  <p>为每一种光线，找到舒适的观看方式。</p>
                </div>
              </div>
              <div className="theme-options">
                {(
                  [
                    { value: 'light', title: '日间', icon: SunIcon },
                    { value: 'dark', title: '夜间', icon: MoonIcon },
                    { value: 'system', title: '跟随系统', icon: DesktopIcon }
                  ] as const
                ).map((item) => (
                  <button
                    className={theme === item.value ? 'active' : ''}
                    key={item.value}
                    onClick={() => setTheme(item.value)}
                    aria-pressed={theme === item.value}
                  >
                    <item.icon size={25} />
                    <span>{item.title}</span>
                    {theme === item.value && <CheckIcon size={16} />}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <h2>数据来源</h2>
                  <p>Steam 安装目录与账号。扫描只读取来源，不复制、不修改任何文件。</p>
                </div>
                <button onClick={() => void openSources()}>管理来源</button>
              </div>
              <div className="directory-field">
                <HardDrivesIcon size={20} />
                <span>
                  {sources.length > 0
                    ? `已登记 ${sources.length} 个来源 · 索引 ${stats?.assets ?? 0} 张截图`
                    : '尚未登记来源'}
                </span>
                <button onClick={() => void openSources()}>打开</button>
              </div>
              {stats ? (
                <p className="panel-note">
                  {stats.games} 款游戏 · {stats.assets} 张索引资产 · {formatBytes(stats.bytes)}
                  {stats.missingFiles > 0 ? ` · ${stats.missingFiles} 个来源文件当前缺失` : ''}
                </p>
              ) : null}
            </section>

            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <h2>远端存储</h2>
                  <p>支持连接 WebDAV。可以是 NAS，也可以是你选择的网盘。</p>
                </div>
                <span className="demo-pill">未接入</span>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  setToast('连接流程尚未接入：没有发送网络请求，也没有保存账号。')
                }}
              >
                <div className="form-grid">
                  <label className="full-width">
                    WebDAV 地址
                    <input
                      type="url"
                      placeholder="https://dav.example.com/screenshots/"
                      required
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    用户名
                    <input placeholder="你的用户名" autoComplete="off" />
                  </label>
                  <label>
                    密码 / 应用专用密码
                    <input
                      type="password"
                      placeholder="请输入密码"
                      autoComplete="new-password"
                    />
                  </label>
                </div>
                <div className="form-footer">
                  <span>本阶段不保存凭据，也不发起连接。</span>
                  <button type="submit">
                    预览连接
                    <ArrowRightIcon size={17} />
                  </button>
                </div>
              </form>
            </section>

            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <h2>本地图库</h2>
                  <p>归档功能尚未接入；当前只建立索引，不复制来源文件。</p>
                </div>
                <HardDrivesIcon size={23} />
              </div>
              <div className="directory-field">
                <FolderOpenIcon size={20} />
                <span>{settings?.libraryRoot ?? '尚未选择图库目录'}</span>
                <button onClick={() => void pickLibraryRoot()}>选择目录</button>
              </div>
            </section>

            <section className="about-row">
              <div>
                <strong>
                  拾光 <span className="muted">/ Steam 截图管理器</span>
                </strong>
                <p>本地索引 · 0.1.0</p>
              </div>
              <button className="text-button" onClick={() => setDiagnostics(!diagnostics)}>
                {diagnostics ? '收起工程诊断' : '工程诊断'}
              </button>
            </section>
            {diagnostics && (
              <section className="settings-card diagnostics">
                {!hasApi ? (
                  <p>工程诊断需要在 Electron 桌面应用中打开。</p>
                ) : (
                  <>
                    <p className="panel-note">
                      下方保留原有工程诊断。数据库自检和目录选择会调用真实的桌面接口。
                    </p>
                    <Diagnostics />
                  </>
                )}
              </section>
            )}
          </div>
        )}
        <footer className="page-footer">
          <span>留住游戏里的好时光</span>
          <span>
            {stats ? `索引 ${stats.assets} 张 · ${formatBytes(stats.bytes)} · 来源只读` : '尚未建立索引'}
          </span>
        </footer>
      </main>

      {sourcesOpen && (
        <Modal label="数据来源" onClose={() => setSourcesOpen(false)} className="collect-dialog">
          <div className="modal-content">
            <div className="section-heading">
              <h2>数据来源</h2>
              <button
                className="icon-button"
                aria-label="关闭数据来源"
                onClick={() => setSourcesOpen(false)}
              >
                <XIcon size={22} />
              </button>
            </div>
            <p className="muted">
              扫描只读取 Steam 目录下的截图并建立索引，不会复制、移动或修改任何来源文件。
            </p>

            <div className="section-heading">
              <h3>已登记来源</h3>
              <button onClick={() => void addSource()}>添加目录</button>
            </div>
            {sources.length === 0 ? (
              <p className="panel-note">还没有登记来源。可以添加 Steam 安装目录或数据目录。</p>
            ) : (
              <div className="collect-list">
                {sources.map((source) => (
                  <label key={source.sourceId}>
                    <input
                      type="radio"
                      name="scan-source"
                      checked={scanSourceId === source.sourceId}
                      onChange={() => {
                        setScanSourceId(source.sourceId)
                        setScanAccounts([])
                      }}
                    />
                    <span>
                      {source.rootPath}
                      <small>
                        {source.accountKeys.length} 个账号 ·{' '}
                        {source.lastScanStatus ? `上次扫描：${source.lastScanStatus}` : '尚未扫描'}
                        {source.lastScanAt
                          ? ` · ${source.lastScanAt.slice(0, 16).replace('T', ' ')}`
                          : ''}
                      </small>
                    </span>
                    <button
                      className="icon-button"
                      aria-label="移除来源"
                      onClick={(event) => {
                        event.preventDefault()
                        void removeSource(source.sourceId)
                      }}
                    >
                      <TrashIcon size={17} />
                    </button>
                  </label>
                ))}
              </div>
            )}

            {discovered.length > 0 && (
              <>
                <div className="section-heading">
                  <h3>自动发现</h3>
                </div>
                <p className="panel-note">
                  {discovered
                    .map(
                      (root) =>
                        `${root.rootPath}（${root.kind}${root.registeredSourceId ? ' · 已登记' : ''}，${root.accounts.length} 个账号）`
                    )
                    .join('；')}
                </p>
              </>
            )}

            {selectedScanSource && selectedScanSource.accountKeys.length > 0 && (
              <>
                <div className="section-heading">
                  <h3>扫描账号</h3>
                  <span className="muted">不选表示全部账号</span>
                </div>
                <div className="collect-list">
                  {selectedScanSource.accountKeys.map((accountKey) => {
                    const raw = accountKey.replace(/^steam-/, '')
                    return (
                      <label key={accountKey}>
                        <input
                          type="checkbox"
                          checked={scanAccounts.includes(raw)}
                          onChange={() =>
                            setScanAccounts((current) =>
                              current.includes(raw)
                                ? current.filter((item) => item !== raw)
                                : [...current, raw]
                            )
                          }
                        />
                        <span>{accountKey}</span>
                      </label>
                    )
                  })}
                </div>
              </>
            )}

            <div className="modal-footer">
              <span className="muted">
                {scanRunning ? scanProgressLabel : `已登记 ${sources.length} 个来源`}
              </span>
              {scanRunning ? (
                <button onClick={() => void cancelScan()}>取消扫描</button>
              ) : (
                <button className="primary" disabled={!scanSourceId} onClick={() => void startScan()}>
                  开始扫描
                  <ArrowRightIcon size={17} />
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {viewer && (
        <Viewer items={viewer.items} initialIndex={viewer.index} onClose={() => setViewer(null)} />
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast('')}>
            <XIcon size={17} />
          </button>
        </div>
      )}
    </div>
  )
}
