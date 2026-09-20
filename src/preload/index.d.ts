import type { RendererApi } from '@shared/ipc'

declare global {
  interface Window {
    readonly api: RendererApi
  }
}

export {}
