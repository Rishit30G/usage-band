import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Cache, Snap } from '../types'

const snap = atom({ plugin: 'usage-band', key: 'snap' } as const, null)

const TTL_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 }
const CTX_WARN = 50
const CTX_CRIT = 80
const LIM_WARN = 60
const LIM_CRIT = 85
const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

// claude-sonnet-5-5 -> Sonnet 5.5; claude-haiku-4-5-20251001 -> Haiku 4.5; unknown ids pass through
const modelName = (id: string) => {
  const m = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[.*\])?$/)
  if (!m) return id
  const [, fam, major, minor, suffix] = m
  return `${fam[0].toUpperCase()}${fam.slice(1)} ${major}${minor ? `.${minor}` : ''}${suffix ?? ''}`
}

// one hue per segment so the band reads at a glance; green/amber/red are reserved for severity
const C = {
  claude: '#D97757',
  sky: '#7cc4ff',
  amber: '#ffb454',
  teal: '#4fd1c5',
  gold: '#f6d365',
  rose: '#ff8fab',
  green: '#7ee787',
  red: '#ff6b6b',
  muted: '#8b93a7',
  line: '#4b5266',
}

const level = (pct: number, warn: number, crit: number) =>
  pct >= crit ? C.red : pct >= warn ? C.amber : C.green

const tok = (n: number) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`

const dur = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`
}

const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  if (s >= 600) return dur(s)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const bar = (pct: number, width = 10) => {
  const n = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return '█'.repeat(n) + '░'.repeat(width - n)
}

// The plugin API doesn't report the prompt cache, but every API response in the
// transcript does: when it was made, which model, the TTL it wrote and what it read.
async function readCache($: any, prev: Cache | null): Promise<Cache | null> {
  const id = await $.session.id()
  if (!/^[0-9a-f-]{36}$/.test(id)) return prev
  const r = await $.process.run([
    'sh',
    '-c',
    `tail -n 400 "$HOME"/.claude/projects/*/${id}.jsonl 2>/dev/null | grep '"cache_creation"' | tail -n 30`,
  ])
  let last: any = null
  let ttlMs: number | null = null
  for (const line of r.stdout.split('\n').reverse()) {
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const u = d?.message?.usage
    if (d.type !== 'assistant' || d.isSidechain || !u) continue
    last ??= d
    // a pure cache hit writes nothing, so the TTL comes from the latest response that wrote
    const cc = u.cache_creation ?? {}
    if (cc.ephemeral_1h_input_tokens > 0) ttlMs = TTL_MS['1h']
    else if (cc.ephemeral_5m_input_tokens > 0) ttlMs = TTL_MS['5m']
    if (ttlMs !== null) break
  }
  if (!last) return prev
  const u = last.message.usage
  const read = u.cache_read_input_tokens ?? 0
  const total = (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0)
  return {
    at: Date.parse(last.timestamp),
    ttlMs: ttlMs ?? prev?.ttlMs ?? TTL_MS['1h'],
    model: last.message.model,
    hitPct: total ? (read / total) * 100 : 0,
  }
}

async function refresh($: any) {
  try {
    const u = await $.session.usage()
    const prev = await read($, snap)
    const now = await $.clock.now()
    let model: string | null = null
    try {
      model = await $.session.model()
    } catch {}
    let cache = prev?.cache ?? null
    try {
      cache = await readCache($, cache)
    } catch {}
    const next: Snap = {
      at: now,
      model,
      cache,
      startedAt: u.startedAt,
      ctxPercent: u.context.percent ?? null,
      ctxTokens: u.context.tokens ?? null,
      ctxWindow: u.context.window,
      usd: u.cost?.usd ?? null,
      limits: u.rateLimits,
    }
    await update($, snap, () => next)
  } catch {
    // session not bound yet; the next tick tries again
  }
}

async function tick($: any) {
  try {
    const prev = await read($, snap)
    if (!prev?.cache) return
    if (prev.cache.at + prev.cache.ttlMs - prev.at < -1000) return // already expired, nothing moves
    const now = await $.clock.now()
    await update($, snap, (cur: any) => (cur ? { ...cur, at: now } : cur))
  } catch {}
}

let isBusy = false

async function handoff($: any) {
  if (isBusy) return
  isBusy = true
  try {
    $.ui.toast('Writing handoff…')
    const msgs = await $.session.messages()
    const transcript = msgs
      .map((m: any) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .filter((t: string) => t.length > 12)
      .join('\n\n')
      .slice(-60000)
    if (!transcript) {
      $.ui.toast('Nothing to hand off yet')
      return
    }
    const r = await $.model.complete({
      model: 'haiku',
      maxTokens: 1500,
      timeoutMs: 90000,
      system: 'You write concise hand-off notes so a fresh coding session can continue seamlessly.',
      prompt:
        'Summarize this session as a hand-off: goal, what was done (files, decisions), current state, open issues, and next steps. Be specific and brief.\n\n' +
        transcript,
    })
    if (!r.isAnswered) {
      $.ui.toast('Handoff failed; session kept')
      return
    }
    await $.command.run({ command: 'clear' })
    await $.prompt.fill({
      text: `Handoff from my previous session:\n\n${r.text}\n\nContinue from here.`,
    })
    $.ui.toast('New session started. Handoff is in the prompt box; press Enter to send.')
  } catch {
    $.ui.toast('Handoff failed; session kept')
  } finally {
    isBusy = false
  }
}

export const register: Register = on => {
  let stopFull: (() => void) | undefined
  let stopTick: (() => void) | undefined

  on('session.start', async ($, e, next) => {
    stopFull?.()
    stopTick?.()
    stopFull = $.clock.every(10000, () => refresh($))
    // cheap 1s tick so the cache countdown moves between full refreshes
    stopTick = $.clock.every(1000, () => tick($))
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await refresh($)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (e.props.hasSurvey || s === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const sep = <Text>   </Text>
    const parts: any[] = []

    if (s.model) {
      parts.push(
        <Text color={C.claude} bold>{modelName(s.model)}</Text>,
      )
    }

    if (s.ctxPercent !== null) {
      const c = level(s.ctxPercent, CTX_WARN, CTX_CRIT)
      parts.push(
        <Text>
          <Text color={c}>{bar(s.ctxPercent)}</Text>
          <Text color={c} bold> {Math.round(s.ctxPercent)}%</Text>
          <Text color={C.muted}>   {tok(s.ctxTokens ?? 0)}/{tok(s.ctxWindow)}</Text>
        </Text>,
      )
    }

    for (const l of s.limits) {
      const left = l.resetsAt ? Math.max(0, (Date.parse(l.resetsAt) - s.at) / 1000) : null
      const c = level(l.percentUsed, LIM_WARN, LIM_CRIT)
      parts.push(
        <Text>
          <Text color={C.amber}>{LABEL[l.kind] ?? l.kind} </Text>
          <Text color={c} bold>{Math.round(l.percentUsed)}%</Text>
          {left !== null ? <Text color={C.muted}>   {dur(left)}</Text> : null}
        </Text>,
      )
    }

    if (s.cache) {
      const c = s.cache
      const left = (c.at + c.ttlMs - s.at) / 1000
      // each model has its own cache: after a switch the next request starts cold
      const switched = !!s.model && modelName(s.model) !== modelName(c.model)
      const hitColor = c.hitPct >= 80 ? C.green : c.hitPct >= 40 ? C.amber : C.red
      parts.push(
        <Text>
          <Text color={C.teal}>⏳ </Text>
          {e.props.isWorking ? (
            <Text color={C.green} bold>warm</Text>
          ) : switched ? (
            <Text color={C.amber} bold>cold, new model</Text>
          ) : left > 0 ? (
            <Text color={left < 300 ? C.amber : C.green} bold>{clock(left)}</Text>
          ) : (
            <Text color={C.muted}>expired</Text>
          )}
          <Text color={hitColor}>   {Math.round(c.hitPct)}% hit</Text>
          {c.ttlMs === TTL_MS['5m'] ? <Text color={C.amber}>   5m TTL</Text> : null}
        </Text>,
      )
    }

    if (s.usd !== null) {
      parts.push(
        <Text>
          <Text>💰 </Text>
          <Text color={C.gold} bold>${s.usd.toFixed(2)}</Text>
        </Text>,
      )
    }

    if (!parts.length) return next(e)

    return (
      <Box justifyContent="space-between">
        <Text>{parts.flatMap((p, i) => (i ? [sep, p] : [p]))}</Text>
        <Button key="handoff" label="Handoff" variant="primary" onPress={() => handoff($)} />
      </Box>
    )
  })
}
