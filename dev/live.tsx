// This machine's real Wayfinder state, for `py dev/preview.py --live`: the saved plans from the
// mod's store, and git answered with real output that the script collects (the kit runs no process).
// Not a test by name; the preview script fills the placeholders and copies it in for one run.
import { mock, test } from 'claude-code/testing'

import { GIT } from './gitgraph'
import { PROGRESS_TOOL } from './lib'

const STORE: Record<string, unknown> = /*STORE*/ {}
const GIT_ANSWERS: Record<string, { exitCode: number; stdout: string }> = /*GIT*/ {}
const SESSION = /*SESSION*/ ''
const CWD = /*CWD*/ ''
const NOW = /*NOW*/ 0

test('live preview', async ($, on) => {
  mock.store(on, STORE)
  mock.clock(on, { now: NOW })
  const asked: { cwd: string; args: string[] }[] = []
  on('process.run', (_, e) => {
    const cwd = String(e.cwd ?? CWD)
    const args = e.argv.slice(GIT.length)
    const known = GIT_ANSWERS[`${cwd}\u0000${args.join('\u0000')}`]
    if (!known) asked.push({ cwd, args })
    return { value: { exitCode: known?.exitCode ?? 1, stdout: known?.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('tool.register', () => ({ value: { tool: PROGRESS_TOOL } }))
  on('command.register', () => ({ value: { command: 'wayfinder' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  // Let the first refresh read git.
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 50))
  console.log('ASKED ' + JSON.stringify(asked))
  const ui = await $.ui.mount({ plugin: 'wayfinder', component: 'Pane', requestId: 'wayfinder', surface: 'desktop', props: { title: 'Wayfinder', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } })
  console.log('PREVIEW ' + JSON.stringify(await ui.find({ type: 'Box' })))
  await ui.unmount()
})
