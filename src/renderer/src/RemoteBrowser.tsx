import { useEffect, useState } from 'react'
import { ArrowClockwiseIcon, ArrowLeftIcon, CheckIcon, FolderIcon, FolderOpenIcon, XIcon } from '@phosphor-icons/react'
import { describeError } from '@shared/messages'
import type { RemoteBrowseDto, RemoteEntryDto } from '@shared/types'
import { call } from './api'
import { Modal } from './Modal'

/**
 * 远端目录浏览器。
 *
 * 以前要在设置里手写 `https://host/webdav/home/xxx/yyyy`，少一段、多一段都只回一个 404，
 * 而且看不出是"路径不对"还是"没权限"。现在连接前就能一层层点进去，选中哪一层就用哪一层。
 */
export function RemoteBrowser({
  kind,
  address,
  username,
  password,
  onPick,
  onClose
}: {
  kind: 'webdav' | 'folder'
  /** WebDAV 地址（浏览的根） */
  readonly address: string
  readonly username: string
  readonly password: string
  onPick(result: { path: string; address: string }): void
  onClose(): void
}) {
  const [path, setPath] = useState('')
  const [browse, setBrowse] = useState<RemoteBrowseDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const result = await call((api) =>
          api.browseRemote({
            kind,
            baseUrl: kind === 'webdav' ? address : '',
            username,
            password,
            path
          })
        )
        if (alive) setBrowse(result)
      } catch (failure) {
        if (alive) {
          setBrowse(null)
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [address, kind, password, path, username])

  const enter = (entry: RemoteEntryDto) => {
    if (!entry.isDir) return
    setPath(entry.path)
  }

  const pick = () => {
    const tail = path.length === 0 ? '' : `/${path}`
    onPick({
      path,
      address: kind === 'webdav' ? `${address.replace(/\/+$/, '')}${tail}` : address
    })
  }

  return (
    <Modal onClose={onClose} label="选择远端目录" className="remote-browser">
      <header className="remote-browser-head">
        <div>
          <h2>选择远端目录</h2>
          <p className="muted">备份只会在选中的目录下建 steam-gallery-v1/，不会动目录里已有的文件。</p>
        </div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <XIcon size={17} />
        </button>
      </header>

      <nav className="remote-browser-path" aria-label="当前路径">
        <button
          type="button"
          className="icon-button"
          aria-label="上一级"
          disabled={path.length === 0}
          onClick={() => setPath(browse?.parent ?? '')}
        >
          <ArrowLeftIcon size={16} />
        </button>
        {(browse?.breadcrumbs ?? [{ name: address || '远端根', path: '' }]).map((crumb, index) => (
          <span key={crumb.path || 'root'} className="crumb">
            {index > 0 && <span className="muted">/</span>}
            <button type="button" onClick={() => setPath(crumb.path)} title={crumb.path || '根目录'}>
              {crumb.name.length > 22 ? `…${crumb.name.slice(-20)}` : crumb.name}
            </button>
          </span>
        ))}
      </nav>

      <div className="remote-browser-list">
        {loading ? (
          <p className="muted">正在读取目录…</p>
        ) : error ? (
          <div className="error-banner inline">
            <div>
              <strong>{describeError(error)}</strong>
            </div>
            <button type="button" onClick={() => setPath((current) => current)}>
              <ArrowClockwiseIcon size={15} /> 重试
            </button>
          </div>
        ) : (browse?.entries.length ?? 0) === 0 ? (
          <p className="muted">这个目录是空的。可以直接用这一层，备份会在这里新建目录。</p>
        ) : (
          <ul>
            {browse?.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className={entry.isDir ? 'entry dir' : 'entry file'}
                  disabled={!entry.isDir}
                  onClick={() => enter(entry)}
                >
                  {entry.isDir ? <FolderIcon size={18} /> : <FolderOpenIcon size={18} />}
                  <span className="entry-name">{entry.name}</span>
                  {entry.size !== null && <span className="muted">{formatSize(entry.size)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="remote-browser-foot">
        <span className="muted">
          {path.length === 0 ? '当前是浏览的根目录' : `将在 ${address.replace(/\/+$/, '')}/${path} 下备份`}
        </span>
        <div className="actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={pick}>
            <CheckIcon size={16} /> 用这个目录
          </button>
        </div>
      </footer>
    </Modal>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
