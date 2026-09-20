import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeftIcon,
  CaretLeftIcon,
  CaretRightIcon,
  InfoIcon,
  DownloadSimpleIcon,
  ArrowsOutSimpleIcon,
} from '@phosphor-icons/react'
import { Modal } from './Modal'
import { gameFor, type PreviewShot } from './preview-data'
export function Viewer({
  items,
  initialIndex,
  onClose,
}: {
  items: PreviewShot[]
  initialIndex: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(initialIndex)
  const [details, setDetails] = useState(false)
  const [actualSize, setActualSize] = useState(false)
  const [notice, setNotice] = useState('')
  const activeThumb = useRef<HTMLButtonElement>(null)
  const shot = items[index]!
  const game = gameFor(shot)
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
            <span>{game.name} · 示例图片</span>
          </div>
          <div className="viewer-tools">
            <button
              className={actualSize ? 'selected' : ''}
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
              onClick={() => setNotice('导出功能待接入，当前未保存文件。')}
            >
              <DownloadSimpleIcon size={18} />
              <span>导出</span>
            </button>
          </div>
        </header>
        <div className={`viewer-body ${details ? 'with-details' : ''}`}>
          <div className="image-stage">
            <div
              className={`image-viewport ${actualSize ? 'actual-size' : ''}`}
            >
              <img key={shot.id} src={shot.src} alt={shot.title} />
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
                <dd>{game.name}</dd>
                <dt>示例拍摄时间</dt>
                <dd>{shot.date}</dd>
                <dt>示例文件名</dt>
                <dd className="mono">{shot.filename}</dd>
                <dt>素材来源</dt>
                <dd>AI 生成的界面示例</dd>
                <dt>备份状态</dt>
                <dd>未连接存储</dd>
              </dl>
              <p className="muted small">
                图片按原比例显示。文件信息仅用于展示，不对应本机文件。
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
                <img src={item.src} alt="" />
                <span>{i + 1}</span>
              </button>
            ))}
          </div>
        </footer>
      </div>
    </Modal>
  )
}
