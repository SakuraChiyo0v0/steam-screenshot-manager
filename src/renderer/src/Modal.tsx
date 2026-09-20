import { useEffect, useRef, type ReactNode } from 'react'
export function Modal({
  children,
  onClose,
  className = '',
  label,
}: {
  children: ReactNode
  onClose: () => void
  className?: string
  label: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    const element = ref.current!
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.showModal()
    return () => {
      element.close()
      document.body.style.overflow = previousOverflow
      queueMicrotask(() => {
        if (
          !document.querySelector('dialog[open]') &&
          returnFocus.current?.isConnected
        )
          returnFocus.current.focus({ preventScroll: true })
      })
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {children}
    </dialog>
  )
}
