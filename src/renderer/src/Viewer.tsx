import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeftIcon,
  CaretLeftIcon,
  CaretRightIcon,
  InfoIcon,
  DownloadSimpleIcon,
  ArrowsOutSimpleIcon,
  WarningCircleIcon,
  ArrowClockwiseIcon
} from '@phosphor-icons/react'
import { isAssetUnavailable, withFailedImage, withRetryToken, withoutFailedImage } from '@shared/gallery-view'
import { Modal } from './Modal'
import type { ViewerItem } from './view-model'

/**
 * 大图查看器。
 *
 * 输入是真实资产（ViewerItem）。`available` 只代表查询时的索引状态，图片请求本身
 * 还会失败（文件被移走、来源断开、图片损坏），因此这里按 assetId 维护加载失败集合：
 * 失败的图切到"原图当前不可用"并提供重试，绝不继续显示破图或声称文件存在。
 * 失败状态按 assetId 记录，所以切到下一张不会沿用上一张的错误。
 */
export function Viewer({
  items,
  initialIndex,
  onClose
}: {
  items: ViewerItem[]
  initialIndex: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(initialIndex)
  const [details, setDetails] = useState(false)
  const [actualSize, setActualSize] = useState(false)
  const [notice, setNotice] = useState('')
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const [attempts, setAttempts] = useState<Record<string, number>>({})
  const activeThumb = useRef<HTMLButtonElement>(null)
  const shot = items[index]!

  const loadFailed = failed.has(shot.id)
  const unavailable = isAssetUnavailable(shot.available, loadFailed)
  const attempt = attempts[shot.id] ?? 0

  useEffect(() => {
    activeThumb.current?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
      behavior: 'smooth'
    })
  }, [index])

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement).tagName)
      )
        return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        setActualSize(false)
        setNotice('')
        setIndex((current) =>
          Math.max(
            0,
            Math.min(items.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1))
          )
        )
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [items.length])

  const go = (next: number) => {
    setIndex(next)
    setActualSize(false)
    setNotice('')
  }

  const markFailed = (assetId: string) => {
    setFailed((current) => withFailedImage(current, assetId))
  }

  const retry = (assetId: string) => {
    setFailed((current) => withoutFailedImage(current, assetId))
    setAttempts((current) => ({ ...current, [assetId]: (current[assetId] ?? 0) + 1 }))
    setNotice('已重新请求原图。')
  }

  return (
    <Modal label="截图查看器" onClose={onClose} className="viewer-dialog">
      <div className="viewer-shell">
        <header className="viewer-header">
          <button className="icon-button" aria-label="关闭查看器" onClick={onClose}>
            <ArrowLeftIcon size={22} />
          </button>
          <div className="viewer-heading">
            <strong>{shot.title}</strong>
            <span>{shot.gameName}</span>
          </div>
          <div className="viewer-tools">
            <button
              className={actualSize ? 'selected' : ''}
              disabled={unavailable}
              onClick={() => setActualSize(!actualSize)}
            >
              <ArrowsOutSimpleIcon size={18} />
              <span>{actualSize ? '适应窗口' : '原始大小'}</span>
            </button>
            <button
              className="icon-button"
              aria-label="图片信息"
              aria-pressed={details}
              onClick={() => setDetails(!details)}
            >
              <InfoIcon size={22} />
            </button>
            <button
              onClick={() =>
                setNotice(
                  unavailable ? '原图不可用，无法导出。' : '导出功能待接入，当前未保存文件。'
                )
              }
            >
              <DownloadSimpleIcon size={18} />
              <span>导出</span>
            </button>
          </div>
        </header>
        <div className={`viewer-body ${details ? 'with-details' : ''}`}>
          <div className="image-stage">
            <div className={`image-viewport ${actualSize ? 'actual-size' : ''}`}>
              {unavailable ? (
                <div className="image-unavailable">
                  <WarningCircleIcon size={42} weight="light" />
                  <h2>原图当前不可用</h2>
                  <p>
                    {loadFailed
                      ? '图片请求失败：文件可能已被移走、来源不可访问，或文件已损坏。索引状态显示为可用，但实际读取失败。'
                      : '这条索引对应的来源文件不存在或已不可访问。'}
                  </p>
                  {loadFailed ? (
                    <button onClick={() => retry(shot.id)}>
                      <ArrowClockwiseIcon size={16} />
                      重新加载
                    </button>
                  ) : null}
                </div>
              ) : (
                <img
                  key={shot.id}
                  src={withRetryToken(shot.src, attempt)}
                  alt={shot.title}
                  onError={() => markFailed(shot.id)}
                />
              )}
            </div>
            <button
              className="image-arrow previous"
              disabled={index === 0}
              aria-label="上一张"
              onClick={() => go(index - 1)}
            >
              <CaretLeftIcon size={26} />
            </button>
            <button
              className="image-arrow next"
              disabled={index === items.length - 1}
              aria-label="下一张"
              onClick={() => go(index + 1)}
            >
              <CaretRightIcon size={26} />
            </button>
          </div>
          {details && (
            <aside className="image-details">
              <p className="eyebrow">图片信息</p>
              <h2>{shot.title}</h2>
              <dl>
                <dt>所属游戏</dt>
                <dd>{shot.gameName}</dd>
                <dt>拍摄时间</dt>
                <dd>{shot.date}</dd>
                <dt>时间来源</dt>
                <dd>{shot.dateSource}</dd>
                <dt>原文件名</dt>
                <dd className="mono">{shot.filename}</dd>
                <dt>尺寸</dt>
                <dd>{shot.width && shot.height ? `${shot.width} × ${shot.height}` : '未知'}</dd>
                <dt>大小</dt>
                <dd>{shot.bytesLabel}</dd>
                <dt>来源文件</dt>
                <dd>
                  {unavailable
                    ? loadFailed
                      ? '索引显示存在，但实际读取失败'
                      : '缺失'
                    : '存在'}
                </dd>
                <dt>备份状态</dt>
                <dd>未接入远端存储</dd>
              </dl>
              <p className="muted small">
                图片按原比例显示。这里展示的是本机来源文件，尚未复制进独立图库。
              </p>
            </aside>
          )}
        </div>
        <footer className="filmstrip-footer">
          <div className="filmstrip-caption">
            {notice && <span role="status">{notice}</span>}
            <span aria-live="polite">
              {index + 1} <span className="muted">/ {items.length}</span>
            </span>
            <span className="muted">方向键切换 · Esc 返回</span>
          </div>
          <div className="filmstrip">
            {items.map((item, i) => {
              const thumbUnavailable = isAssetUnavailable(item.available, failed.has(item.id))
              return (
                <button
                  ref={i === index ? activeThumb : null}
                  key={item.id}
                  className={i === index ? 'active' : ''}
                  aria-label={`查看 ${item.title}`}
                  aria-pressed={i === index}
                  onClick={() => go(i)}
                >
                  {thumbUnavailable ? (
                    <WarningCircleIcon size={18} />
                  ) : (
                    <img
                      src={withRetryToken(item.thumbSrc, attempts[item.id] ?? 0)}
                      alt=""
                      onError={() => markFailed(item.id)}
                    />
                  )}
                  <span>{i + 1}</span>
                </button>
              )
            })}
          </div>
        </footer>
      </div>
    </Modal>
  )
}
