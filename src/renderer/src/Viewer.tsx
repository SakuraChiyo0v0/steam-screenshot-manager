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
import {
  IMAGE_FAILURE_KEYS,
  isAssetUnavailable,
  withFailedImage,
  withRetryToken,
  withoutFailedImage
} from '@shared/gallery-view'
import { call } from './api'
import { Modal } from './Modal'
import type { ViewerItem } from './view-model'

/**
 * 大图查看器。
 *
 * 失败状态按「原图」与「缩略图」分别记录（IMAGE_FAILURE_KEYS）：
 * 缩略图损坏只影响底部缩略图带（回退到原图，再不行才显示警告图标），
 * 绝不据此关闭已经正常显示的主图。失败集合按 key 记录，切图不会沿用上一张的错误。
 */
/** 缩略图带只渲染当前项附近这么多张：几千张时逐个渲染会占用大量 DOM 与图片内存。 */
const FILMSTRIP_WINDOW = 30

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
  const [exporting, setExporting] = useState(false)
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const [attempts, setAttempts] = useState<Record<string, number>>({})
  const activeThumb = useRef<HTMLButtonElement>(null)
  const shot = items[index]!

  const originalKey = IMAGE_FAILURE_KEYS.original(shot.id)
  const originalFailed = failed.has(originalKey)
  const unavailable = isAssetUnavailable(shot.available, originalFailed)
  const attempt = attempts[originalKey] ?? 0

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

  /** 迷你预览就绪后让缩略图带重新请求，换成清晰且更轻的版本。 */
  useEffect(() => {
    const api = window.api
    if (!api?.onPreviewReady) return
    api.onPreviewReady((payload: { assetId: string; size: 'preview' | 'mini' }) => {
      if (payload.size !== 'mini') return
      const key = IMAGE_FAILURE_KEYS.thumbnail(payload.assetId)
      setAttempts((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }))
    })
    return () => api.offPreviewReady()
  }, [])

  const markFailed = (key: string) => {
    setFailed((current) => withFailedImage(current, key))
  }

  /** 真实导出：选择目录后导出这一张，导出后会校验写入文件的指纹。 */
  const exportCurrent = async () => {
    setExporting(true)
    setNotice('')
    try {
      const dir = await call((api) => api.pickExportDir())
      if (!dir.targetDir) {
        setNotice('已取消选择导出目录。')
        return
      }
      const summary = await call((api) =>
        api.startExport({ targetDir: dir.targetDir!, layout: 'game-year', assetIds: [shot.id] })
      )
      if (summary.written > 0) {
        setNotice(`已导出 1 张到 ${summary.targetDir}`)
      } else if (summary.skipped > 0) {
        setNotice('目标目录已有相同文件，未重复写入。')
      } else {
        setNotice(summary.failed > 0 ? '导出失败，详见同步中心的任务说明。' : '没有可导出的内容。')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setExporting(false)
    }
  }

  const retry = (key: string) => {
    setFailed((current) => withoutFailedImage(current, key))
    setAttempts((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }))
    setNotice('已重新请求图片。')
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
            <button disabled={exporting || (unavailable && !shot.archived)} onClick={() => void exportCurrent()}>
              <DownloadSimpleIcon size={18} />
              <span>{exporting ? '导出中…' : '导出'}</span>
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
                    {originalFailed
                      ? '图片请求失败：文件可能已被移走、来源不可访问，或文件已损坏。索引状态显示为可用，但实际读取失败。'
                      : '这条索引对应的来源文件不存在或已不可访问。'}
                  </p>
                  {originalFailed ? (
                    <button onClick={() => retry(originalKey)}>
                      <ArrowClockwiseIcon size={16} />
                      重新加载
                    </button>
                  ) : null}
                </div>
              ) : (
                <img
                  key={originalKey}
                  src={withRetryToken(shot.src, attempt)}
                  alt={shot.title}
                  onError={() => markFailed(originalKey)}
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
                    ? originalFailed
                      ? '索引显示存在，但实际读取失败'
                      : '缺失'
                    : '存在'}
                </dd>
                <dt>图库副本</dt>
                <dd>{shot.archived ? '已归档到本机图库' : '尚未归档'}</dd>
                <dt>备份状态</dt>
                <dd>{shot.backedUp ? '已备份到远端' : '尚未备份到远端'}</dd>
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
              // 窗口外只留占位，保证滚动宽度与居中定位不变
              if (Math.abs(i - index) > FILMSTRIP_WINDOW) {
                return <span className="filmstrip-spacer" key={item.id} aria-hidden="true" />
              }
              const thumbKey = IMAGE_FAILURE_KEYS.thumbnail(item.id)
              const itemOriginalKey = IMAGE_FAILURE_KEYS.original(item.id)
              const thumbFailed = failed.has(thumbKey)
              const itemOriginalFailed = failed.has(itemOriginalKey)
              // 缩略图坏了先回退原图；只有缩略图与原图都不可用时才显示警告图标
              // 缩略图带用的是 200px 迷你图，避免几十张 800px 纹理常驻显存
              const source = thumbFailed ? (itemOriginalFailed ? null : item.src) : item.miniSrc
              const sourceKey = thumbFailed ? itemOriginalKey : thumbKey
              return (
                <button
                  ref={i === index ? activeThumb : null}
                  key={item.id}
                  className={i === index ? 'active' : ''}
                  aria-label={`查看 ${item.title}${thumbFailed ? '（缩略图不可用）' : ''}`}
                  aria-pressed={i === index}
                  onClick={() => go(i)}
                >
                  {source ? (
                    <img
                      src={withRetryToken(source, attempts[sourceKey] ?? 0)}
                      alt=""
                      onError={() => markFailed(sourceKey)}
                    />
                  ) : (
                    <WarningCircleIcon size={18} />
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
