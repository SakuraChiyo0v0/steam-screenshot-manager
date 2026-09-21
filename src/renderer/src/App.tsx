import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  CaretDownIcon,
  CaretRightIcon,
  WarningCircleIcon,
  ArrowsClockwiseIcon,
  TrashIcon,
  ArrowClockwiseIcon
} from '@phosphor-icons/react'
import type {
  AccountSummaryDto,
  ArchiveStatusDto,
  DiscoveredRootDto,
  GalleryAssetDto,
  GalleryGameDto,
  CapabilityItemDto,
  LibraryCopyStateDto,
  LibraryStatsDto,
  PreviewStatsDto,
  RemoteStateDto,
  UploadStatusDto,
  RegisteredSourceDto,
  ScanProgressDto,
  ScanStatusDto,
  Settings
} from '@shared/types'
import {
  IMAGE_FAILURE_KEYS,
  isAssetUnavailable,
  mergeAssetPages,
  resolveLibraryViewState,
  withFailedImage,
  withRetryToken,
  withoutFailedImage
} from '@shared/gallery-view'
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
  /** 排序弹层：原生 select 的弹层由系统绘制，深色主题下是白底白字，改用 DOM 弹层统一跟随主题。 */
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!sortMenuOpen) {
      return
    }
    const onPointerDown = (event: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
        setSortMenuOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSortMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [sortMenuOpen])

  const [accounts, setAccounts] = useState<AccountSummaryDto[]>([])
  const [stats, setStats] = useState<LibraryStatsDto | null>(null)
  const [games, setGames] = useState<GalleryGameDto[]>([])
  const [assets, setAssets] = useState<GalleryAssetDto[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)

  const [sources, setSources] = useState<RegisteredSourceDto[]>([])
  const [discovered, setDiscovered] = useState<DiscoveredRootDto[]>([])
  const [scanStatus, setScanStatus] = useState<ScanStatusDto | null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [scanAccounts, setScanAccounts] = useState<string[]>([])
  const [scanSourceId, setScanSourceId] = useState<string | null>(null)

  const [viewer, setViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null)
  const [toast, setToast] = useState('')
  const [remoteState, setRemoteState] = useState<RemoteStateDto | null>(null)
  const [uploadStatus, setUploadStatus] = useState<UploadStatusDto | null>(null)
  const [connectForm, setConnectForm] = useState({ baseUrl: '', username: '', password: '' })
  const [connecting, setConnecting] = useState(false)
  const [capabilities, setCapabilities] = useState<CapabilityItemDto[] | null>(null)
  const [diagnostics, setDiagnostics] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [copyState, setCopyState] = useState<LibraryCopyStateDto | null>(null)
  const [previewState, setPreviewState] = useState<PreviewStatsDto | null>(null)
  const [archiveStatus, setArchiveStatus] = useState<ArchiveStatusDto | null>(null)

  /**
   * 请求序号：每次刷新或追加都自增，只有序号仍是最新的响应才允许写入状态。
   * 这样切换筛选/搜索后到达的旧响应会被丢弃，不会把上一个查询的结果混进来。
   */
  const requestToken = useRef(0)
  /** 图片加载失败集合与重试次数，按 IMAGE_FAILURE_KEYS 的键记录（原图与缩略图分开）。 */
  const [failedImages, setFailedImages] = useState<ReadonlySet<string>>(new Set())
  const [imageAttempts, setImageAttempts] = useState<Record<string, number>>({})
  /** 是否已经成功建立过索引（用于区分"尚未扫描的空库"与"筛选无匹配"）。 */
  const [scannedOnce, setScannedOnce] = useState(false)

  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  const hasApi = getApi() !== null
  const installedParam = installedFilter === 'all' ? null : installedFilter === 'installed'
  const assetSort = sort === 'oldest' ? 'captured-asc' : 'captured-desc'
  const filtered = search.trim().length > 0 || accountFilter !== null || installedFilter !== 'all'

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

  const rememberScanState = useCallback(
    (stat: LibraryStatsDto, sourceList: RegisteredSourceDto[]) => {
      if (stat.assets > 0 || sourceList.some((item) => item.lastScanAt !== null)) {
        setScannedOnce(true)
      }
    },
    []
  )

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
    rememberScanState(stat, sourceList)
  }, [hasApi, rememberScanState])

  /** 首屏：账号、统计、来源、扫描状态、本机设置。 */
  useEffect(() => {
    void (async () => {
      if (!hasApi) {
        setLoading(false)
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
        rememberScanState(stat, sourceList)
      } catch (error) {
        setLoadError(errorMessage(error))
      }
    })()
  }, [hasApi, rememberScanState])

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

  /** 归档进度事件订阅。 */
  useEffect(() => {
    const api = getApi()
    if (!api) return
    api.onArchiveProgress((status: ArchiveStatusDto) => setArchiveStatus(status))
    return () => api.offArchiveProgress()
  }, [])

  /**
   * 预览就绪事件：这张图之前可能因为还没有预览而回退到原图，
   * 现在换成清晰且更轻的预览（只触发一次，因为预览只会生成一次）。
   */
  useEffect(() => {
    const api = getApi()
    if (!api) return
    api.onPreviewReady((payload: { assetId: string; size: 'preview' | 'mini' }) => {
      const key =
        payload.size === 'mini'
          ? IMAGE_FAILURE_KEYS.thumbnail(payload.assetId)
          : IMAGE_FAILURE_KEYS.original(payload.assetId)
      setImageAttempts((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }))
    })
    return () => api.offPreviewReady()
  }, [])

  /** 上传进度事件订阅。 */
  useEffect(() => {
    const api = getApi()
    if (!api) return
    api.onUploadProgress((status: UploadStatusDto) => setUploadStatus(status))
    return () => api.offUploadProgress()
  }, [])

  const refreshRemoteState = useCallback(async () => {
    if (!hasApi) return
    try {
      setRemoteState(await call((api) => api.getRemoteState()))
    } catch {
      /* 远端状态读取失败不影响其它功能 */
    }
  }, [hasApi])

  useEffect(() => {
    void refreshRemoteState()
  }, [refreshRemoteState])

  const refreshCopyState = useCallback(async () => {
    if (!hasApi) return
    try {
      setCopyState(await call((api) => api.getLibraryCopyState()))
    } catch {
      /* 图库状态读取失败不影响其它功能 */
    }
  }, [hasApi])

  useEffect(() => {
    void refreshCopyState()
  }, [refreshCopyState])

  const refreshPreviewState = useCallback(async () => {
    if (!hasApi) return
    try {
      setPreviewState(await call((api) => api.getPreviewStats()))
    } catch {
      /* 预览统计读取失败不影响其它功能 */
    }
  }, [hasApi])

  useEffect(() => {
    void refreshPreviewState()
    // 浏览过程中预览会在后台补齐，定期刷新统计
    const timer = setInterval(() => void refreshPreviewState(), 20_000)
    return () => clearInterval(timer)
  }, [refreshPreviewState])

  /** 更新本机设置；部分字段需要主进程同步调整运行状态（如开机自启）。 */
  const patchSettings = async (patch: Partial<Settings>) => {
    try {
      setSettings(await call((api) => api.updateSettings(patch)))
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  const refreshLibrary = useCallback(async () => {
    if (!hasApi) return
    const token = requestToken.current + 1
    requestToken.current = token

    setLoading(true)
    setLoadError(null)
    setLoadMoreError(null)
    setLoadingMore(false)

    try {
      if (page === 'library' && !gameId) {
        const rows = await call((api) =>
          api.listGames({ query: search, installed: installedParam, accountKey: accountFilter })
        )
        if (token !== requestToken.current) return
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
        if (token !== requestToken.current) return
        // 新查询用返回结果整体替换，不做追加
        setAssets([...result.items])
        setNextCursor(result.nextCursor)
      }
    } catch (error) {
      if (token !== requestToken.current) return
      setLoadError(errorMessage(error))
    } finally {
      if (token === requestToken.current) {
        setLoading(false)
      }
    }
  }, [hasApi, page, gameId, search, installedParam, accountFilter, assetSort])

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshLibrary()
    }, 220)
    return () => clearTimeout(timer)
  }, [refreshLibrary])

  /**
   * 追加下一页。
   *
   * 三处保护：loadingMore 阻止并发、请求序号丢弃过期响应、按 assetId 去重。
   */
  const loadMore = useCallback(async () => {
    if (!nextCursor || !hasApi || loadingMore) return

    const token = requestToken.current
    const cursor = nextCursor
    setLoadingMore(true)
    setLoadMoreError(null)

    try {
      const result = await call((api) =>
        api.listAssets({
          gameKey: gameId,
          query: search,
          installed: installedParam,
          accountKey: accountFilter,
          sort: assetSort,
          cursor,
          limit: PAGE_SIZE
        })
      )
      if (token !== requestToken.current) return
      setAssets((current) => mergeAssetPages(current, result.items))
      setNextCursor(result.nextCursor)
    } catch (error) {
      if (token !== requestToken.current) return
      setLoadMoreError(errorMessage(error))
    } finally {
      if (token === requestToken.current) {
        setLoadingMore(false)
      }
    }
  }, [
    nextCursor,
    hasApi,
    loadingMore,
    gameId,
    search,
    installedParam,
    accountFilter,
    assetSort
  ])

  /**
   * 滚动到底自动加载下一页。
   *
   * 用滚动监听而不是 IntersectionObserver：后台/最小化时 Chromium 会限制（甚至不派发）
   * IntersectionObserver 回调，而滚动监听仍然可靠。捕获阶段监听可以同时收到内层滚动容器的滚动。
   * loadMore 自身有并发保护，重复调用是安全的。
   */
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null)
  const loadMoreRef = useRef(loadMore)
  useEffect(() => {
    loadMoreRef.current = loadMore
  }, [loadMore])
  useEffect(() => {
    if (!nextCursor) {
      return
    }
    const check = () => {
      const node = loadMoreSentinelRef.current
      if (!node) {
        return
      }
      const rect = node.getBoundingClientRect()
      if (rect.top - window.innerHeight < 600) {
        void loadMoreRef.current()
      }
    }
    check()
    window.addEventListener('scroll', check, { capture: true, passive: true })
    window.addEventListener('resize', check)
    return () => {
      window.removeEventListener('scroll', check, { capture: true })
      window.removeEventListener('resize', check)
    }
  }, [nextCursor])

  const navigate = (next: Page) => {
    setPage(next)
    setGameId(null)
    setSearch('')
    setSort('recent')
    setDiagnostics(false)
  }

  const markImageFailed = useCallback((key: string) => {
    setFailedImages((current) => withFailedImage(current, key))
  }, [])

  const retryImage = useCallback((key: string) => {
    setFailedImages((current) => withoutFailedImage(current, key))
    setImageAttempts((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }))
  }, [])

  const imageSrc = useCallback(
    (key: string, base: string) => withRetryToken(base, imageAttempts[key] ?? 0),
    [imageAttempts]
  )

  const visibleGames = useMemo<GameCard[]>(() => {
    const cards = games.map(toGameCard)
    return sort === 'name' ? [...cards].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) : cards
  }, [games, sort])

  /** 游戏库按名称排，相册按拍摄时间排。 */
  const sortOptions = useMemo(
    () =>
      page === 'library' && !gameId
        ? [
            { value: 'recent', label: '最近拍摄' },
            { value: 'name', label: '游戏名称' }
          ]
        : [
            { value: 'recent', label: '最近拍摄' },
            { value: 'oldest', label: '最早拍摄' }
          ],
    [page, gameId]
  )

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

  const connectRemoteAction = async () => {
    setConnecting(true)
    try {
      const result = await call((api) =>
        api.connectRemote({
          baseUrl: connectForm.baseUrl,
          username: connectForm.username,
          password: connectForm.password
        })
      )
      setCapabilities([...result.capabilities])
      setConnectForm((current) => ({ ...current, password: '' }))
      setToast(
        result.capabilities.every((item) => item.ok)
          ? `已连接远端，使用图库 ${result.libraryId}。`
          : `已连接，但有 ${result.capabilities.filter((item) => !item.ok).length} 项能力测试未通过。`
      )
      await refreshRemoteState()
    } catch (error) {
      setCapabilities(null)
      setToast(errorMessage(error))
    } finally {
      setConnecting(false)
    }
  }

  const disconnectRemoteAction = async () => {
    try {
      setRemoteState(await call((api) => api.disconnectRemote()))
      setCapabilities(null)
      setToast('已断开远端存储，并删除本机保存的凭据。')
      await refreshRemoteState()
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  const startUpload = async (forceRetry = false) => {
    setToast(forceRetry ? '正在重试失败项…' : '备份已开始，可以继续浏览界面。')
    try {
      const summary = await call((api) => api.startUpload(forceRetry ? { forceRetry: true } : {}))
      setToast(
        `备份完成：计划 ${summary.total}，已校验 ${summary.verified}（新传 ${summary.uploaded}），失败 ${summary.failed}，耗时 ${(summary.durationMs / 1000).toFixed(1)} 秒${summary.cancelled ? '（已取消）' : ''}${summary.abortedByAuth ? '（远端拒绝认证）' : ''}。`
      )
      await refreshRemoteState()
    } catch (error) {
      setToast(errorMessage(error))
      await refreshRemoteState()
    }
  }

  const cancelUpload = async () => {
    try {
      setUploadStatus(await call((api) => api.cancelUpload()))
      setToast('已请求暂停，当前文件传完后停止；已完成的备份保留。')
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  const startArchive = async () => {
    setToast('归档已开始，可以继续浏览界面。')
    try {
      const summary = await call((api) => api.startArchive({}))
      setToast(
        `归档完成：计划 ${summary.total}，新复制 ${summary.copied}，已存在 ${summary.skipped}，失败 ${summary.failed}，耗时 ${(summary.durationMs / 1000).toFixed(1)} 秒${summary.cancelled ? '（已取消）' : ''}。`
      )
      await refreshCopyState()
      await refreshLibrary()
    } catch (error) {
      setToast(errorMessage(error))
      await refreshCopyState()
    }
  }

  const cancelArchive = async () => {
    try {
      setArchiveStatus(await call((api) => api.cancelArchive()))
      setToast('已请求取消归档，当前文件处理完后停止。')
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  const reconcileLibrary = async () => {
    try {
      const result = await call((api) => api.reconcileLibrary())
      setToast(
        `对账完成：检查 ${result.checked}，副本缺失 ${result.missing}，清理临时文件 ${result.stagingCleaned}。`
      )
      await refreshCopyState()
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
  const archiveRunning = archiveStatus?.running === true
  const uploadRunning = uploadStatus?.running === true
  const remoteConnected = remoteState?.connected === true
  const scanProgressLabel = scanStatus
    ? scanStatus.total === null
      ? `正在统计文件（已发现 ${scanStatus.processed}）`
      : `${scanStatus.processed} / ${scanStatus.total}`
    : ''

  const itemCount = page === 'library' && !gameId ? visibleGames.length : viewerItems.length
  const viewState = resolveLibraryViewState({
    hasApi,
    loading,
    error: loadError,
    itemCount,
    hasAnyIndex: scannedOnce,
    filtered
  })

  /** 错误时若已有旧结果，仍然渲染列表，与横幅里"保留上一次结果"的说明保持一致。 */
  const listVisible = viewState === 'ready' || (viewState === 'error' && itemCount > 0)

  const clearFilters = () => {
    setSearch('')
    setAccountFilter(null)
    setInstalledFilter('all')
  }

  /** 查询失败时的错误区：独立于列表，明确说明旧结果是否保留，并提供重试。 */
  const errorBanner = loadError ? (
    <div className="error-banner" role="alert">
      <WarningCircleIcon size={22} />
      <div>
        <strong>查询失败</strong>
        <p>{loadError}</p>
        <p className="muted small">
          {itemCount > 0
            ? '下方仍显示上一次成功加载的结果，可能与你当前的筛选条件不一致。'
            : '当前没有可显示的结果。'}
        </p>
      </div>
      <button onClick={() => void refreshLibrary()}>
        <ArrowClockwiseIcon size={16} />
        重试
      </button>
    </div>
  ) : null

  const emptyBlock =
    viewState === 'no-api' ? (
      <div className="empty-state">
        <DesktopIcon size={42} weight="light" />
        <h2>需要桌面环境</h2>
        <p>浏览器预览没有桌面接口，图库与扫描不可用。</p>
      </div>
    ) : viewState === 'loading' ? (
      <div className="empty-state">
        <ArrowsClockwiseIcon size={42} weight="light" />
        <h2>正在读取索引</h2>
        <p>从本机数据库加载游戏与截图。</p>
      </div>
    ) : viewState === 'error' ? (
      <div className="empty-state">
        <WarningCircleIcon size={42} weight="light" />
        <h2>查询失败</h2>
        <p>{loadError ?? '无法读取图库数据。'}</p>
        <button onClick={() => void refreshLibrary()}>
          <ArrowClockwiseIcon size={16} />
          重试
        </button>
      </div>
    ) : viewState === 'empty-filtered' ? (
      <div className="empty-state">
        <MagnifyingGlassIcon size={42} weight="light" />
        <h2>当前筛选没有匹配结果</h2>
        <p>索引里已有数据，但这个条件下没有匹配项。</p>
        <button onClick={clearFilters}>清除筛选</button>
      </div>
    ) : viewState === 'empty-scanned' ? (
      <div className="empty-state">
        <HardDrivesIcon size={42} weight="light" />
        <h2>索引里目前没有截图</h2>
        <p>来源已扫描过，但索引中没有资产。可以重新扫描，或检查来源目录是否仍然可用。</p>
        {hasApi ? <button onClick={() => void openSources()}>打开数据来源</button> : null}
      </div>
    ) : (
      <div className="empty-state">
        <HardDrivesIcon size={42} weight="light" />
        <h2>还没有建立索引</h2>
        <p>先登记 Steam 数据来源并执行一次扫描，索引完成后这里会显示真实截图。</p>
        {hasApi ? <button onClick={() => void openSources()}>打开数据来源</button> : null}
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
              <div className="sort-label" ref={sortMenuRef}>
                <span>排序</span>
                <button
                  type="button"
                  className={`sort-trigger${sortMenuOpen ? ' open' : ''}`}
                  aria-haspopup="listbox"
                  aria-expanded={sortMenuOpen}
                  aria-label="排序"
                  onClick={() => setSortMenuOpen((open) => !open)}
                >
                  <span>{sortOptions.find((option) => option.value === sort)?.label}</span>
                  <CaretDownIcon size={13} />
                </button>
                {sortMenuOpen ? (
                  <div className="sort-menu" role="listbox" aria-label="排序">
                    {sortOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={sort === option.value}
                        className={`sort-menu-item${sort === option.value ? ' active' : ''}`}
                        onClick={() => {
                          setSort(option.value)
                          setSortMenuOpen(false)
                        }}
                      >
                        <span>{option.label}</span>
                        {sort === option.value ? <CheckIcon size={14} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            {errorBanner}

            {listVisible && page === 'library' && !gameId ? (
              <div className="game-grid">
                {visibleGames.map((game) => {
                  const coverKey = IMAGE_FAILURE_KEYS.cover(game.key)
                  const coverFailed = failedImages.has(coverKey)
                  const coverUnavailable = !game.coverUrl || coverFailed
                  return (
                    <div className="game-card" key={game.key}>
                      {/* 进入相册是卡片主体按钮；重试是并列按钮，不嵌套在按钮里 */}
                      <button
                        className="card-main"
                        onClick={() => {
                          setGameId(game.key)
                          setSearch('')
                          setSort('recent')
                        }}
                      >
                        <div className="card-image">
                          {coverUnavailable ? (
                            <div className="card-missing">
                              <ImagesIcon size={20} weight="light" />
                              <span>{coverFailed ? '封面加载失败' : '暂无可用截图'}</span>
                            </div>
                          ) : (
                            <img
                              src={imageSrc(coverKey, game.coverUrl!)}
                              alt={`${game.name} 最近一张截图`}
                              onError={() => markImageFailed(coverKey)}
                            />
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
                      {coverFailed && game.coverUrl ? (
                        <div className="card-actions">
                          <button className="card-retry" onClick={() => retryImage(coverKey)}>
                            <ArrowClockwiseIcon size={14} />
                            重新加载封面
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : listVisible ? (
              <>
                <div className="shot-grid">
                  {viewerItems.map((shot, index) => {
                    const originalKey = IMAGE_FAILURE_KEYS.original(shot.id)
                    const originalFailed = failedImages.has(originalKey)
                    const unavailable = isAssetUnavailable(shot.available, originalFailed)
                    return (
                      <div className="shot-card" key={shot.id}>
                        {/* 打开大图是卡片主体按钮；重试是并列按钮，不嵌套在按钮里 */}
                        <button
                          className="card-main"
                          onClick={() => setViewer({ items: viewerItems, index })}
                        >
                          <div className="card-image">
                            {unavailable ? (
                              <div className="card-missing">
                                <WarningCircleIcon size={20} weight="light" />
                                <span>原图不可用</span>
                              </div>
                            ) : (
                              <img
                                src={imageSrc(originalKey, shot.thumbSrc)}
                                alt={shot.title}
                                loading="lazy"
                                decoding="async"
                                onError={() => markImageFailed(originalKey)}
                              />
                            )}
                            <span className="card-open">
                              <ImagesIcon size={20} />
                            </span>
                          </div>
                          <div className="shot-caption">
                            <strong>{shot.title}</strong>
                            <span>
                              {unavailable ? '原图不可用' : gameId ? shot.date : shot.gameName}
                            </span>
                          </div>
                        </button>
                        {originalFailed ? (
                          <div className="card-actions">
                            <button
                              className="card-retry"
                              onClick={() => retryImage(originalKey)}
                            >
                              <ArrowClockwiseIcon size={14} />
                              重新加载原图
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
                {loadMoreError ? (
                  <div className="error-banner inline" role="alert">
                    <WarningCircleIcon size={20} />
                    <div>
                      <strong>加载更多失败</strong>
                      <p>{loadMoreError}</p>
                      <p className="muted small">已加载的 {viewerItems.length} 张仍然有效。</p>
                    </div>
                    <button disabled={loadingMore} onClick={() => void loadMore()}>
                      <ArrowClockwiseIcon size={16} />
                      重试
                    </button>
                  </div>
                ) : null}
                {nextCursor ? (
                  <div className="load-more-sentinel" ref={loadMoreSentinelRef}>
                    <span className="muted small">
                      {loadingMore
                        ? '正在加载更多…'
                        : `已加载 ${viewerItems.length} 张，继续向下滚动会自动加载`}
                    </span>
                  </div>
                ) : (
                  <div className="load-more-sentinel">
                    <span className="muted small">已全部加载 {viewerItems.length} 张</span>
                  </div>
                )}
              </>
            ) : (
              emptyBlock
            )}
          </>
        )}

        {page === 'sync' && (
          <>
            {!remoteConnected ? (
              <div className="connection-banner">
                <span className="connection-icon">
                  <CloudArrowUpIcon size={29} />
                </span>
                <div>
                  <h2>还没有连接远端存储</h2>
                  <p>使用自己的 WebDAV。连接后可以先备份，再在另一台电脑恢复。</p>
                </div>
                <button onClick={() => navigate('settings')}>
                  配置存储
                  <ArrowRightIcon size={17} />
                </button>
              </div>
            ) : (
              <>
                <div className="connection-banner">
                  <span className="connection-icon">
                    <CloudArrowUpIcon size={29} />
                  </span>
                  <div>
                    <h2>{remoteState?.baseUrl}</h2>
                    <p>
                      图库 {remoteState?.libraryId} · 上次检查{' '}
                      {remoteState?.lastCheckAt
                        ? remoteState.lastCheckAt.slice(0, 16).replace('T', ' ')
                        : '—'}
                      （{remoteState?.lastCheckStatus ?? '未知'}）
                    </p>
                  </div>
                  {uploadRunning ? (
                    <button onClick={() => void cancelUpload()}>暂停</button>
                  ) : (
                    <button
                      className="primary"
                      disabled={!remoteState?.libraryRoot}
                      onClick={() => void startUpload(false)}
                    >
                      开始备份
                      <ArrowRightIcon size={17} />
                    </button>
                  )}
                </div>
                {uploadRunning ? (
                  <div className="error-banner inline" role="status">
                    <ArrowsClockwiseIcon size={20} />
                    <div>
                      <strong>正在上传</strong>
                      <p>
                        {uploadStatus?.total === null
                          ? `正在规划（已处理 ${uploadStatus?.processed ?? 0}）`
                          : `${uploadStatus?.processed ?? 0} / ${uploadStatus?.total ?? 0}`}
                        {' · '}已校验 {uploadStatus?.verified ?? 0}
                        {uploadStatus?.failed ? ` · 失败 ${uploadStatus.failed}` : ''}
                        {uploadStatus?.currentFile ? ` · ${uploadStatus.currentFile}` : ''}
                      </p>
                    </div>
                  </div>
                ) : null}
                <div className="task-panel">
                  <div className="task-toolbar">
                    <div className="tabs">
                      <button className="active">全部 {remoteState?.assets ?? 0}</button>
                      <button>已备份 {remoteState?.verified ?? 0}</button>
                      <button>待备份 {remoteState?.pending ?? 0}</button>
                      <button>失败 {remoteState?.failed ?? 0}</button>
                    </div>
                    <div className="actions">
                      <button
                        disabled={uploadRunning || (remoteState?.failed ?? 0) === 0}
                        onClick={() => void startUpload(true)}
                      >
                        重试失败项
                      </button>
                      <button onClick={() => void disconnectRemoteAction()}>断开连接</button>
                    </div>
                  </div>
                  <p className="panel-note">
                    只有「上传对象 → 读回校验哈希 → 发布记录 → 读回校验记录」全部通过，才会记为已备份。本机删除不会传播到远端。
                  </p>
                  {!remoteState?.libraryRoot ? (
                    <p className="panel-note">
                      还没有本地图库目录：请先在设置里选择目录并完成归档，再开始备份。
                    </p>
                  ) : null}
                  {uploadStatus?.errorMessage ? (
                    <p className="panel-note">上次错误：{uploadStatus.errorMessage}</p>
                  ) : null}
                </div>
              </>
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
                <span className="demo-pill">{remoteConnected ? '已连接' : '未连接'}</span>
              </div>
              {!remoteState?.credentialStorageAvailable ? (
                <p className="panel-note">
                  当前系统无法安全加密保存密码，因此不提供连接；不会以明文保存凭据。
                </p>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void connectRemoteAction()
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
                        value={connectForm.baseUrl}
                        onChange={(event) =>
                          setConnectForm({ ...connectForm, baseUrl: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      用户名
                      <input
                        autoComplete="off"
                        value={connectForm.username}
                        onChange={(event) =>
                          setConnectForm({ ...connectForm, username: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      密码 / 应用专用密码
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={connectForm.password}
                        onChange={(event) =>
                          setConnectForm({ ...connectForm, password: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  <div className="form-footer">
                    <span>密码只保存在本机系统加密存储，不写入数据库，也不进日志。</span>
                    <button type="submit" disabled={connecting}>
                      {connecting ? '连接中…' : '测试并连接'}
                      <ArrowRightIcon size={17} />
                    </button>
                  </div>
                </form>
              )}
              {capabilities ? (
                <ul className="capability-list">
                  {capabilities.map((item) => (
                    <li key={item.name} className={item.ok ? 'ok' : 'fail'}>
                      {item.ok ? <CheckIcon size={15} /> : <WarningCircleIcon size={15} />}
                      <strong>{item.name}</strong>
                      <span>{item.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {remoteConnected ? (
                <div className="form-footer">
                  <span>图库 {remoteState?.libraryId}</span>
                  <div className="actions">
                    <button onClick={() => void disconnectRemoteAction()}>
                      断开并删除本机凭据
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <h2>本地图库</h2>
                  <p>把来源截图复制进独立图库；来源只读，不会被修改或移动。</p>
                </div>
                <HardDrivesIcon size={23} />
              </div>
              <div className="directory-field">
                <FolderOpenIcon size={20} />
                <span>{settings?.libraryRoot ?? '尚未选择图库目录'}</span>
                <button onClick={() => void pickLibraryRoot()}>选择目录</button>
              </div>
              {copyState ? (
                <p className="panel-note">
                  已归档 {copyState.archived} / {copyState.assets} 张
                  {copyState.missing > 0 ? ` · ${copyState.missing} 个副本当前缺失` : ''}
                  {copyState.assets > 0 && copyState.archived === copyState.assets
                    ? ' · 全部已归档'
                    : ''}
                </p>
              ) : null}
              {archiveRunning ? (
                <div className="error-banner inline" role="status">
                  <ArrowsClockwiseIcon size={20} />
                  <div>
                    <strong>正在归档</strong>
                    <p>
                      {archiveStatus?.total === null
                        ? `正在统计（已处理 ${archiveStatus?.processed ?? 0}）`
                        : `${archiveStatus?.processed ?? 0} / ${archiveStatus?.total ?? 0}`}
                      {archiveStatus?.currentFile ? ` · ${archiveStatus.currentFile}` : ''}
                      {archiveStatus?.failed ? ` · 失败 ${archiveStatus.failed}` : ''}
                    </p>
                  </div>
                  <button onClick={() => void cancelArchive()}>取消</button>
                </div>
              ) : (
                <div className="form-footer">
                  <span>归档只新增副本；重复执行不会重复复制。</span>
                  <div className="actions">
                    <button onClick={() => void reconcileLibrary()}>对账</button>
                    <button
                      className="primary"
                      disabled={!settings?.libraryRoot}
                      onClick={() => void startArchive()}
                    >
                      开始归档
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <h2>日常使用</h2>
                  <p>让收集和备份自己跑起来，平时不用一直手动点。</p>
                </div>
                <GearSixIcon size={23} />
              </div>
              <div className="toggle-list">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.preferOriginalImages !== false}
                    onChange={(event) =>
                      void patchSettings({ preferOriginalImages: event.target.checked })
                    }
                  />
                  <span>
                    <strong>图片优先原图</strong>
                    <small>
                      直接显示高清原图，不用来源自带的约 200px 缩略图；占用更高但不会发虚。关闭后先给缩略图省资源。
                    </small>
                  </span>
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.autoCollect === true}
                    onChange={(event) => void patchSettings({ autoCollect: event.target.checked })}
                  />
                  <span>
                    <strong>后台自动收集</strong>
                    <small>按间隔增量扫描来源并归档新增截图（归档是幂等的，不会重复复制）</small>
                  </span>
                </label>
                <label className="toggle-row">
                  <span>
                    <strong>收集间隔</strong>
                    <small>分钟；仅在开启自动收集时生效</small>
                  </span>
                  <input
                    className="number-input"
                    type="number"
                    min={5}
                    max={1440}
                    value={settings?.autoCollectIntervalMinutes ?? 60}
                    onChange={(event) =>
                      void patchSettings({
                        autoCollectIntervalMinutes: Math.max(5, Number(event.target.value) || 60)
                      })
                    }
                  />
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.autoBackup === true}
                    onChange={(event) => void patchSettings({ autoBackup: event.target.checked })}
                  />
                  <span>
                    <strong>收集后自动备份到远端</strong>
                    <small>需要已连接远端存储；未连接时会跳过并记录</small>
                  </span>
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.closeToTray === true}
                    onChange={(event) => void patchSettings({ closeToTray: event.target.checked })}
                  />
                  <span>
                    <strong>关闭窗口时留在托盘</strong>
                    <small>任务继续执行；从托盘菜单或退出应用才真正结束</small>
                  </span>
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.launchAtLogin === true}
                    onChange={(event) => void patchSettings({ launchAtLogin: event.target.checked })}
                  />
                  <span>
                    <strong>开机自动启动</strong>
                    <small>登录后直接开始后台收集</small>
                  </span>
                </label>
              </div>
              <p className="panel-note">
                预览缓存：{previewState ? `${previewState.count} 张 / ${formatBytes(previewState.bytes)}` : '读取中…'}
                {previewState && previewState.pending > 0
                  ? ` · 后台待生成 ${previewState.pending} 张`
                  : ''}
                （浏览时自动补齐，可随时删除重建）
              </p>
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
