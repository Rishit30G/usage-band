import { test, expect } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 140 },
} as const

const HOUR = 3600 * 1000
const NOW = Date.parse('2026-10-10T12:00:00Z')

test('band stays out of the way before any usage is read', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeUndefined()
    await ui.unmount()
  }
})

test('band shows the 5h and weekly limits and a Handoff button, with no full-in warning', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('turn.complete', () => ({ text: '' }))
  on('clock.now', () => ({ value: NOW }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - HOUR,
      context: { tokens: 50000, window: 200000, percent: 25 },
      cost: { usd: 1.5 },
      // 90% used one hour into the 5h window: the old band would have warned "full in"
      rateLimits: [
        { kind: 'five_hour', percentUsed: 90, resetsAt: new Date(NOW + 4 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 32, resetsAt: new Date(NOW + 76 * HOUR).toISOString() },
      ],
    },
  }))

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^5h $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^7d $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\s*3d 4h$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resets/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /full in/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'summarize' })).toBeUndefined()
    await ui.unmount()
  }
})
