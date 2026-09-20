import { useEffect, useState } from 'react'
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
} from '@phosphor-icons/react'
import {
  games,
  shots,
  shotsFor,
  gameFor,
  type PreviewShot,
} from './preview-data'
import { Viewer } from './Viewer'
import { Modal } from './Modal'
import { Diagnostics } from './Diagnostics'

type Page = 'library' | 'all' | 'sync' | 'settings'
type Theme = 'dark' | 'light' | 'system'
const nav = [
  { id: 'library', title: '游戏库', icon: SquaresFourIcon },
  { id: 'all', title: '全部截图', icon: ImagesIcon },
  { id: 'sync', title: '同步中心', icon: CloudArrowUpIcon },
] as const
function readTheme(): Theme {
  try {
    const value = localStorage.getItem('ssm-ui-theme')
    return value === 'light' || value === 'system' ? value : 'dark'
  } catch {
    return 'dark'
  }
}

export function App() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [systemDark, setSystemDark] = useState(
    matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const [page, setPage] = useState<Page>('library')
  const [gameId, setGameId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [genre, setGenre] = useState('全部游戏')
  const [sort, setSort] = useState('recent')
  const [viewer, setViewer] = useState<{
    items: PreviewShot[]
    index: number
  } | null>(null)
  const [collect, setCollect] = useState(false)
  const [chosen, setChosen] = useState(games.map((game) => game.id))
  const [toast, setToast] = useState('')
  const [syncDemo, setSyncDemo] = useState(false)
  const [paused, setPaused] = useState(false)
  const [syncFilter, setSyncFilter] = useState('全部任务')
  const [diagnostics, setDiagnostics] = useState(false)
  const resolvedTheme =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
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
      /* 偏好无法保存不影响预览。 */
    }
  }, [theme, resolvedTheme])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 4500)
    return () => clearTimeout(timer)
  }, [toast])
  const navigate = (next: Page) => {
    setPage(next)
    setGameId(null)
    setSearch('')
    setSort('recent')
    setDiagnostics(false)
  }
  const selectedGame = games.find((game) => game.id === gameId)
  const query = search.trim().toLocaleLowerCase()
  const visibleGames = games
    .filter(
      (game) =>
        (genre === '全部游戏' || genre === game.genre) &&
        `${game.name} ${game.english}`.toLocaleLowerCase().includes(query),
    )
    .sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : 0,
    )
  const visibleShots = (gameId ? shotsFor(gameId) : shots)
    .filter((shot) =>
      `${shot.title} ${gameFor(shot).name} ${shot.filename}`
        .toLocaleLowerCase()
        .includes(query),
    )
    .sort((a, b) =>
      sort === 'oldest'
        ? a.date.localeCompare(b.date)
        : b.date.localeCompare(a.date),
    )
  const openShot = (items: PreviewShot[], index: number) =>
    setViewer({ items, index })
  const empty = (
    <div className="empty-state">
      <MagnifyingGlassIcon size={42} weight="light" />
      <h2>没有找到相关内容</h2>
      <p>试试其他名称，或者清除当前筛选。</p>
      <button
        onClick={() => {
          setSearch('')
          setGenre('全部游戏')
        }}
      >
        清除筛选
      </button>
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
              <item.icon
                size={21}
                weight={page === item.id ? 'fill' : 'regular'}
              />
              <span>{item.title}</span>
              {item.id === 'all' && <small>{shots.length}</small>}
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
            <span className="preview-tag">UI 预览</span>
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
                  settings: '设置',
                }[page]}
            </h1>
            <p>
              {selectedGame
                ? `${shotsFor(selectedGame.id).length} 张截图 · ${selectedGame.english}`
                : {
                    library: '按游戏收藏，随时重温。',
                    all: '每一个值得留下的瞬间。',
                    sync: '让珍贵的画面，在每台设备上延续。',
                    settings: '按你的习惯，安放每一份回忆。',
                  }[page]}
            </p>
          </div>
          {(page === 'library' || page === 'all') && (
            <button className="primary" onClick={() => setCollect(true)}>
              <PlusIcon size={19} />
              收集截图
            </button>
          )}
        </header>
        {(page === 'library' || page === 'all') && (
          <>
            <div className="library-toolbar">
              <div className="tabs" aria-label="分类">
                {page === 'library' && !gameId ? (
                  ['全部游戏', '角色扮演', '开放世界', '动作冒险'].map(
                    (item) => (
                      <button
                        key={item}
                        className={genre === item ? 'active' : ''}
                        onClick={() => setGenre(item)}
                      >
                        {item}
                        {item === '全部游戏' && <small>{games.length}</small>}
                      </button>
                    ),
                  )
                ) : (
                  <span className="muted">
                    {visibleShots.length} 张示例截图
                  </span>
                )}
              </div>
              <div className="search-control">
                <MagnifyingGlassIcon size={18} />
                <input
                  aria-label="搜索截图或游戏"
                  placeholder={
                    page === 'library' && !gameId ? '搜索游戏…' : '搜索截图…'
                  }
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
                  ? `${visibleGames.length} 款游戏 · ${visibleGames.reduce((count, game) => count + shotsFor(game.id).length, 0)} 张截图`
                  : selectedGame
                    ? '游戏相册'
                    : '所有游戏的精彩瞬间'}{' '}
                <span className="demo-pill">示例</span>
              </span>
              <label className="sort-label">
                排序
                <select
                  aria-label="排序"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="recent">最近更新</option>
                  {page === 'library' && !gameId ? (
                    <option value="name">游戏名称</option>
                  ) : (
                    <option value="oldest">最早拍摄</option>
                  )}
                </select>
              </label>
            </div>
            {page === 'library' && !gameId ? (
              visibleGames.length ? (
                <div className="game-grid">
                  {visibleGames.map((game) => (
                    <button
                      className="game-card"
                      key={game.id}
                      onClick={() => {
                        setGameId(game.id)
                        setSearch('')
                        setSort('recent')
                      }}
                    >
                      <div className="card-image">
                        <img src={game.cover} alt={`${game.name} 示例画面`} />
                        <span className="image-count">
                          <ImagesIcon size={14} />
                          {shotsFor(game.id).length} 张
                        </span>
                        <span className="card-open">
                          <ArrowRightIcon size={20} />
                        </span>
                      </div>
                      <div className="card-body">
                        <h2>{game.name}</h2>
                        <p>{game.english}</p>
                        <div className="card-meta">
                          <span>{game.genre}</span>
                          <span>
                            {shotsFor(game.id)[0]!
                              .date.slice(5, 10)
                              .replace('-', '/')}{' '}
                            更新
                          </span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                empty
              )
            ) : visibleShots.length ? (
              <div className="shot-grid">
                {visibleShots.map((shot, index) => (
                  <button
                    className="shot-card"
                    key={shot.id}
                    onClick={() => openShot(visibleShots, index)}
                  >
                    <div className="card-image">
                      <img src={shot.src} alt={shot.title} />
                      <span className="card-open">
                        <ImagesIcon size={20} />
                      </span>
                    </div>
                    <div className="shot-caption">
                      <strong>{shot.title}</strong>
                      <span>
                        {gameId ? shot.date.slice(5, 16) : gameFor(shot).name}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              empty
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
                <p>使用自己的 WebDAV，让截图有处可存。</p>
              </div>
              <button onClick={() => navigate('settings')}>
                配置存储
                <ArrowRightIcon size={17} />
              </button>
            </div>
            <div className="section-heading">
              <h2>传输任务</h2>
              <button
                className="text-button"
                onClick={() => setSyncDemo(!syncDemo)}
              >
                {syncDemo ? '隐藏任务示例' : '查看任务示例'}
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
                {shots
                  .slice(0, 3)
                  .filter(
                    (_, i) =>
                      syncFilter === '全部任务' ||
                      (syncFilter === '待处理' ? i === 0 : i === 1),
                  )
                  .map((shot) => {
                    const i = shots.indexOf(shot)
                    return (
                      <div className="task-row" key={shot.id}>
                        <img src={shot.src} alt="" />
                        <div>
                          <strong>{shot.title}</strong>
                          <span>{gameFor(shot).name} · 上传任务示例</span>
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
                            onClick={() =>
                              setToast(
                                '重试操作预览：未连接 WebDAV，也未发送文件。',
                              )
                            }
                          >
                            重试
                          </button>
                        )}
                      </div>
                    )
                  })}
                <p className="panel-note">
                  以上为静态任务示例，未发生实际传输。
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
                    { value: 'system', title: '跟随系统', icon: DesktopIcon },
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
                  <h2>远端存储</h2>
                  <p>支持连接 WebDAV。可以是 NAS，也可以是你选择的网盘。</p>
                </div>
                <span className="demo-pill">未连接</span>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  setToast(
                    '连接流程仅供预览。没有发送网络请求，也没有保存账号。',
                  )
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
                  <span>当前为界面预览，填写内容不会保存。</span>
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
                  <p>收集后的截图，统一保存到你指定的目录。</p>
                </div>
                <HardDrivesIcon size={23} />
              </div>
              <div className="directory-field">
                <FolderOpenIcon size={20} />
                <span>尚未选择图库目录</span>
                <button
                  onClick={() =>
                    setToast('目录选择界面待接入。本轮不会读取或移动本机文件。')
                  }
                >
                  选择目录
                </button>
              </div>
            </section>
            <section className="about-row">
              <div>
                <strong>
                  拾光 <span className="muted">/ Steam 截图管理器</span>
                </strong>
                <p>UI Preview · 0.1.0</p>
              </div>
              <button
                className="text-button"
                onClick={() => setDiagnostics(!diagnostics)}
              >
                {diagnostics ? '收起工程诊断' : '工程诊断'}
              </button>
            </section>
            {diagnostics && (
              <section className="settings-card diagnostics">
                {typeof window.api === 'undefined' ? (
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
          <span>示例图库 · 尚未读取本机截图</span>
        </footer>
      </main>
      {collect && (
        <Modal
          label="收集截图预览"
          onClose={() => setCollect(false)}
          className="collect-dialog"
        >
          <div className="modal-content">
            <div className="section-heading">
              <h2>收集截图</h2>
              <button
                className="icon-button"
                aria-label="关闭收集预览"
                onClick={() => setCollect(false)}
              >
                <XIcon size={22} />
              </button>
            </div>
            <p className="muted">
              选择想加入图库的游戏。这里展示收集流程，不扫描本机文件。
            </p>
            <div className="collect-list">
              {games.map((game) => (
                <label key={game.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(game.id)}
                    onChange={() =>
                      setChosen((current) =>
                        current.includes(game.id)
                          ? current.filter((id) => id !== game.id)
                          : [...current, game.id],
                      )
                    }
                  />
                  <img src={game.cover} alt="" />
                  <span>
                    {game.name}
                    <small>{shotsFor(game.id).length} 张示例图片</small>
                  </span>
                </label>
              ))}
            </div>
            <div className="modal-footer">
              <span className="muted">已选 {chosen.length} 款游戏</span>
              <button
                className="primary"
                disabled={!chosen.length}
                onClick={() => {
                  setCollect(false)
                  setToast(
                    `已预览 ${chosen.length} 款游戏的收集流程，未导入或复制文件。`,
                  )
                }}
              >
                预览收集
                <ArrowRightIcon size={17} />
              </button>
            </div>
          </div>
        </Modal>
      )}
      {viewer && (
        <Viewer
          items={viewer.items}
          initialIndex={viewer.index}
          onClose={() => setViewer(null)}
        />
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
