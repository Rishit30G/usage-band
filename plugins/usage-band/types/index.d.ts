export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
// the last main-thread API response, read from the session's transcript
export type Cache = { at: number; ttlMs: number; model: string; hitPct: number }
export type Snap = {
  at: number
  model: string | null
  cache: Cache | null
  startedAt: number
  ctxPercent: number | null
  ctxTokens: number | null
  ctxWindow: number
  usd: number | null
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snap: Snap | null }
  }
}
