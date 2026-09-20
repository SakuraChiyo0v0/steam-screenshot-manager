import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeftIcon,
  CaretLeftIcon,
  CaretRightIcon,
  InfoIcon,
  DownloadSimpleIcon,
  ArrowsOutSimpleIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { Modal } from './Modal'
import type { ViewerItem } from './view-model'

/**
 * 大图查看器。
 *
 * 输入是真实资产（ViewerItem）。原图缺失时显示缺失状态，不回退到别的图片，
 * 避免让用户以为看到的是这张截图。
 */
export function Viewer({
  items,
  initialIndex,
  onClose,
}: {
  items: ViewerItem[]
  initialIndex: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(initialIndex)
  const [details, setDetails] = useState(false)
  const [actualSize, setActualSize] = useState(false)
  const [notice, setNotice] = useState('')
  const activeThumb = useRef<HTMLButtonElement>(null)
  const shot = items[index]!
  useEffect(() => {
    activeThumb.current?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
      behavior: 'smooth',
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
        setIndex((current) =>
          Math.max(
            0,
            Math.min(
              items.length - 1,
              current + (event.key === 'ArrowRight' ? 1 : -1),
            ),
          ),
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
  return (
    <Modal label="截图查看器" onClose={onClose} className="viewer-dialog">
      <div className="viewer-shell">
        <header className="viewer-header">
          <button
            className="icon-button"
            aria-label="关闭查看器"
            onClick={onClose}
          >
            <ArrowLeftIcon size={22} />
          </button>
          <div className="viewer-heading">
            <strong>{shot.title}</strong>
            <span>{shot.gameName}</span>
          </div>
          <div className="viewer-tools">
            <button
              className={actualSize ? 'selected' : ''}
              disabled={!shot.available}
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
                  shot.available
                    ? '导出功能待接入，当前未保存文件。'
                    : '原图缺失，无法导出。',
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
              {shot.available ? (
                <img key={shot.id} src={shot.src} alt={shot.title} />
              ) : (
                <div className="empty-state">
                  <WarningCircleIcon size={42} weight="light" />
                  <h2>原图当前不可用</h2>
                  <p>这条索引对应的来源文件不存在或已不可访问。</p>
                </div>
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
                <dd>
                  {shot.width && shot.height
                    ? `${shot.width} × ${shot.height}`
                    : '未知'}
                </dd>
                <dt>大小</dt>
                <dd>{shot.bytesLabel}</dd>
                <dt>来源文件</dt>
                <dd>{shot.available ? '存在' : '缺失'}</dd>
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
            {items.map((item, i) => (
              <button
                ref={i === index ? activeThumb : null}
                key={item.id}
                className={i === index ? 'active' : ''}
                aria-label={`查看 ${item.title}`}
                aria-pressed={i === index}
                onClick={() => go(i)}
              >
                {item.available ? (
                  <img src={item.thumbSrc} alt="" />
                ) : (
                  <WarningCircleIcon size={18} />
                )}
                <span>{i + 1}</span>
              </button>
            ))}
          </div>
        </footer>
      </div>
    </Modal>
  )
}
