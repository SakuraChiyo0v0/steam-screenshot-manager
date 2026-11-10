import { CheckCircleIcon, CircleIcon, ArrowRightIcon, HardDrivesIcon } from '@phosphor-icons/react'

/**
 * 首页的「还没做完的事」清单。
 *
 * 以前打开应用看到的是三个并列的空态（没来源、没图库、没远端），得自己悟出
 * 「登记来源 → 扫描 → 选图库 → 归档 → 配远端 → 备份」这条链。
 * 这里按顺序列出四步，做完的打勾，只把**下一步**高亮成按钮。
 */
export interface SetupStep {
  readonly id: 'sources' | 'index' | 'library' | 'remote'
  readonly title: string
  readonly detail: string
  readonly done: boolean
  readonly actionLabel: string
  readonly action: () => void
}

export function SetupChecklist({ steps }: { steps: readonly SetupStep[] }) {
  const firstOpen = steps.findIndex((step) => !step.done)
  if (firstOpen < 0) {
    return null
  }

  return (
    <section className="setup-checklist" aria-label="还没做完的事">
      <header>
        <div>
          <h2>再做完这几步，就能自动备份了</h2>
          <p className="muted">按顺序来；已经做完的会打勾。</p>
        </div>
        <HardDrivesIcon size={23} />
      </header>
      <ol>
        {steps.map((step, index) => {
          const isNext = index === firstOpen
          return (
            <li key={step.id} className={step.done ? 'done' : isNext ? 'next' : 'pending'}>
              <span className="step-mark">
                {step.done ? <CheckCircleIcon size={19} weight="fill" /> : <CircleIcon size={19} />}
              </span>
              <div className="step-main">
                <strong>{step.title}</strong>
                <small className="muted">{step.detail}</small>
              </div>
              {isNext && (
                <button type="button" className="primary" onClick={step.action}>
                  {step.actionLabel}
                  <ArrowRightIcon size={16} />
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
