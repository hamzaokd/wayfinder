// A sample session for dev/preview.py: mounts the pane with fixture data and prints its render tree.
// Not a test by name, so `claude plugin test .` skips it; the preview script copies it in for one run.
import { mock, test } from 'claude-code/testing'

import { GIT } from './gitgraph'
import { PROGRESS_TOOL } from './lib'
import { captureDialogs, dump } from './zz-dump'

const H = (c: string) => c.repeat(40)
const MIN = 60_000

test('preview', { options: { autoStart: /*AUTOSTART*/ true } }, async ($, on) => {
  const repo = { head: H('c'), log: '' }
  // Another desktop session waiting on you: its name links to its chat.
  const login = { sessionId: 'login', hostId: 'local_11111111-2222-3333-4444-555555555555', goal: 'Fix login redirect', phases: ['P'], steps: [{ title: 'Confirm the SSO callback URL', phase: 'P', status: 'doing', waitingOn: 'you', waitingFor: 'check it in the Okta admin', files: [] }], decisions: [], events: [], seen: {}, turn: 3, planTurn: 3, planVersion: 1, commitsSincePlan: 0, pending: [], hasNudged: true, updatedAt: 1_800_000_000_000 + 80 * MIN, lastPromptAt: 1_800_000_000_000 + 80 * MIN, unplannedFiles: [] }
  mock.store(on, { 'trail2:login': login })
  const dialogs = captureDialogs(on)
  on('settings.read', () => ({ value: { language: /*LANG*/ 'english' } }))
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('process.run', (_, e) => {
    const a = e.argv.slice(GIT.length).join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const sec = (min: number) => Math.round((1_800_000_000_000 + min * MIN) / 1000)
    const base = H('m')
    if (a === 'rev-parse --show-toplevel') return ok('C:/r')
    if (a === 'symbolic-ref --short HEAD') return ok('feature/export')
    if (a === 'rev-parse HEAD') return ok(repo.head)
    if (a === 'status --porcelain') return ok(' M src/writer.ts\n M src/export.ts')
    if (a.startsWith('merge-base --is-ancestor')) return ok('')
    if (a.startsWith('log --reverse')) return ok(repo.log)
    if (a === 'rev-parse --verify --quiet refs/heads/main') return ok(base)
    if (a.startsWith('rev-list --left-right --count main...HEAD')) return ok('1\t3')
    if (a.startsWith('for-each-ref')) return ok(`feature/export\t${repo.head}\t${sec(70)}\nmain\t${base}\t${sec(40)}\nfix/login\t${H('l')}\t${sec(50)}`)
    if (a === 'rev-parse main') return ok(base)
    if (a.startsWith('diff --name-only')) return ok('src/writer.ts')
    if (a.startsWith('merge-base --octopus')) return ok(H('0'))
    if (a.startsWith('log --date-order'))
      return ok(
        [
          `${H('c')}\t${H('b')}\t${sec(70)}\tstream rows to the writer`,
          `${H('l')}\t${H('0')}\t${sec(50)}\tfix login redirect`,
          `${base}\t${H('0')}\t${sec(40)}\thotfix: null header`,
          `${H('b')}\t${H('a')}\t${sec(30)}\tadd CSV writer`,
          `${H('a')}\t${H('0')}\t${sec(12)}\tcheck S3 role`,
          `${H('0')}\t\t${sec(-60)}\trelease 1.4`,
        ].join('\n'),
      )
    if (a.startsWith('stash list')) return ok('')
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: 'preview' }))
  on('env.get', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: PROGRESS_TOOL } }))
  on('command.register', () => ({ value: { command: 'wayfinder' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:/r', surface: 'desktop', isInteractive: true })

  const plan = (investigate: string[], build: string[], ship: string[]) => ({
    tool: PROGRESS_TOOL,
    goal: 'Add CSV export',
    whereWasI: 'Writer streams rows; benchmark on staging next.',
    phases: [
      { title: 'Investigate', steps: [{ title: 'Check S3 permissions', status: investigate[0], note: 'yes, via role X' }, { title: 'Read the export spec', status: investigate[1] }] },
      { title: 'Build', steps: [{ title: 'CSV writer', status: build[0] }, { title: 'Stream rows', status: build[1] }, { title: 'Benchmark on 1M rows', status: build[2], waitingOn: 'you', waitingFor: 'run it on staging' }] },
      { title: 'Ship', steps: [{ title: 'Docs', status: ship[0] }, { title: 'Open PR', status: ship[1] }] },
    ],
    decisions: [],
  })
  await $.tool.call(plan(['doing', 'todo'], ['todo', 'todo', 'todo'], ['todo', 'todo']))
  await clock.advance(15 * MIN)
  await $.tool.call(plan(['done', 'done'], ['doing', 'todo', 'todo'], ['todo', 'todo']))
  await clock.advance(30 * MIN)
  await $.tool.call({ ...plan(['done', 'done'], ['done', 'doing', 'todo'], ['todo', 'todo']), decisions: [{ text: 'stream rows instead of buffering', why: 'memory on 1M rows' }] })
  await clock.advance(30 * MIN)
  await $.tool.call(plan(['done', 'done'], ['done', 'done', 'doing'], ['todo', 'todo']))
  await clock.advance(16_000)

  const ui = await $.ui.mount({ plugin: 'wayfinder', component: 'Pane', requestId: 'wayfinder', surface: 'desktop', props: { title: 'Wayfinder', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } })
  await dump(ui, dialogs, $)
  await ui.unmount()
})
