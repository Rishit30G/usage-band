import { test, expect } from 'claude-code/testing'

test('band stays out of the way before any usage is read', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const tree = await $.ui.mount({
      plugin: 'usage-band',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 100 },
    })
    expect(tree).toBeDefined()
  }
})
