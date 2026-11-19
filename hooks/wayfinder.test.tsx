import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { RepoLive } from '../types'
import { graphSvg, graphText, items, SHOW_ALL } from './graph'
import { applyPlan, attributeEdits, dirsFromToolUse, emptyTrail, normPath, PROGRESS_TOOL, sinceYouLeft, stepAction, waitingOnYou } from './lib'

const PANE = {
  plugin: 'wayfinder',
  component: 'Pane',
  requestId: 'wayfinder',
  props: {
    title: 'Wayfinder',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const ctx = (now: number) => ({ now, repo: 'C:/r', branch: 'feature/x' })
const plan = (steps: [string, string, string][]) => {
  const phases: { title: string; steps: { title: string; status: string }[] }[] = []
  for (const [phase, title, status] of steps) {
    let p = phases.find(x => x.title === phase)
    if (!p) phases.push((p = { title: phase, steps: [] }))
    p.steps.push({ title, status })
  }
  return phases
}

test('paths from tool calls', () => {
  expect(normPath('/c/Users/me/repo')).toBe('C:/Users/me/repo')
  expect(normPath('C:\\Users\\me\\repo')).toBe('C:/Users/me/repo')
  expect(dirsFromToolUse({ file_path: 'C:\\a\\b\\file.ts' })).toEqual(['C:/a/b'])
  expect(dirsFromToolUse({ command: 'cd "/c/work/api" && git status' })).toEqual(['C:/work/api'])
  expect(dirsFromToolUse({ command: 'git -C C:/work/web log' })).toEqual(['C:/work/web'])
  expect(dirsFromToolUse({ command: 'cd src && ls' })).toEqual([])
})

test('plan changes need a reason and show as drift', () => {
  const t0 = emptyTrail('s1', 0)
  expect(() => applyPlan(t0, { phases: [{ title: 'A', steps: [{ title: 'x', status: 'nope' }] }] }, ctx(1))).toThrow()
  expect(() => applyPlan(t0, { phases: plan([['A', 'x', 'todo'], ['A', 'x', 'todo']]) }, ctx(1))).toThrow()
  const t1 = applyPlan(t0, { goal: 'Export', phases: plan([['Investigate', 'Check perms', 'doing'], ['Build', 'Writer', 'todo'], ['Ship', 'Docs', 'todo']]) }, ctx(1))
  expect(t1.events.filter(e => e.kind === 'drift')).toEqual([])
  expect(t1.steps[0]).toMatchObject({ startedAt: 1, repo: 'C:/r', branch: 'feature/x' })

  const next = plan([['Investigate', 'Check perms', 'done'], ['Build', 'Fix flaky test', 'doing'], ['Build', 'Writer', 'todo']])
  expect(() => applyPlan(t1, { phases: next }, ctx(2))).toThrow('say why in change.reason')
  const t2 = applyPlan(t1, { phases: next, change: { reason: 'tests broke' }, decisions: [{ text: 'stream rows', why: 'memory' }] }, ctx(2))
  const flaky = t2.steps.find(s => s.title === 'Fix flaky test')!
  expect(flaky).toMatchObject({ addedLate: true, reason: 'tests broke' })
  expect(t2.steps.find(s => s.title === 'Docs')).toMatchObject({ status: 'dropped', reason: 'tests broke' })
  expect(t2.events.filter(e => e.kind === 'drift').map(e => e.text)).toEqual(['Added "Fix flaky test": tests broke', 'Dropped "Docs": tests broke'])
  expect(t2.decisions[0]).toMatchObject({ text: 'stream rows', why: 'memory', step: 'Fix flaky test' })

  // Writer done while the flaky test is still... doing, not todo: in order. Then out of order:
  const t3 = applyPlan(t2, { phases: plan([['Investigate', 'Check perms', 'done'], ['Build', 'Fix flaky test', 'todo'], ['Build', 'Writer', 'done']]) }, ctx(3))
  expect(t3.steps.find(s => s.title === 'Writer')?.outOfOrder).toBe(true)
})

test('edits are filed under the step that was current', () => {
  const t = applyPlan(emptyTrail('s1', 0), { phases: plan([['P', 'A', 'doing'], ['P', 'B', 'todo']]) }, ctx(1))
  const uses = [
    { tool: 'Edit', input: { file_path: 'C:/r/early.ts' } },
    { tool: PROGRESS_TOOL, input: { phases: plan([['P', 'A', 'doing'], ['P', 'B', 'todo']]) } },
    { tool: 'Edit', input: { file_path: 'C:\\r\\a.ts' } },
    { tool: PROGRESS_TOOL, input: { phases: plan([['P', 'A', 'done'], ['P', 'B', 'doing']]) } },
    { tool: 'Write', input: { file_path: 'C:/r/b.ts' } },
    { tool: 'Read', input: { file_path: 'C:/r/c.ts' } },
  ]
  const out = attributeEdits(t, uses, ['C:/r'])
  expect(out.unplannedFiles).toEqual(['C:/r/early.ts'])
  expect(out.steps.map(s => s.files)).toEqual([['C:/r/a.ts'], ['C:/r/b.ts']])
  expect(out.activeStep).toBe('B')
  expect(out.lastRepo).toBe('C:/r')
})

test('waiting on you, and since you left', () => {
  const self = applyPlan(emptyTrail('s1', 0), { goal: 'CSV', phases: [{ title: 'P', steps: [{ title: 'Bench', status: 'todo', waitingOn: 'you', waitingFor: 'run on staging' }] }] }, ctx(1))
  const other = { ...applyPlan(emptyTrail('s2', 0), { goal: 'Login', phases: [{ title: 'P', steps: [{ title: 'Answer', status: 'doing', waitingOn: 'you' }] }] }, ctx(1)), updatedAt: 50 * 60_000 }
  expect(waitingOnYou(self, [other]).map(w => `${w.isSelf}:${w.step}:${w.what ?? ''}`)).toEqual(['true:Bench:run on staging', 'false:Answer:'])
  const back = { ...self, lastPromptAt: 0, events: [{ at: 10, kind: 'commit' as const, origin: 'outside' as const, repo: 'api', text: 'x', hash: 'h' }] }
  expect(sinceYouLeft(back, [other], [], 5 * 60_000)).toBeUndefined()
  const card = sinceYouLeft(back, [other], [{ at: 30 * 60_000, subject: 'WIP' }], 60 * 60_000)!
  expect(card.lines).toEqual(['1 commit(s) outside this session: api', '1 new stash(es)', '"Login" moved on: now on Answer'])
  expect(card.next).toBe('Bench (waiting on you)')
})

const H = (c: string) => c.repeat(40)
function live(over: Partial<RepoLive> = {}): RepoLive {
  return {
    root: 'C:/r', name: 'r', branch: 'feature/x', head: H('b'), dirty: 2, dirtyFiles: ['a.ts', 'b.ts'], base: 'main', behindBase: 1,
    graph: {
      lanes: [
        { branch: 'main', relevance: 1, why: 'base', isBase: true, tip: H('m') },
        { branch: 'feature/x', relevance: 1, why: 'current', isCurrent: true, tip: H('b'), forkFrom: H('0') },
        { branch: 'fix/login', relevance: 0.55, why: 'also edits auth.ts', tip: H('l'), forkFrom: H('0') },
      ],
      commits: [
        { hash: H('0'), parents: [], at: 100, subject: 'release', lane: 0 },
        { hash: H('b'), parents: [H('0')], at: 300, subject: 'add writer', lane: 1 },
        { hash: H('l'), parents: [H('0')], at: 350, subject: 'fix login', lane: 2 },
        { hash: H('m'), parents: [H('0')], at: 400, subject: 'hotfix', lane: 0 },
      ],
      stashes: [{ name: 'stash@{0}', subject: 'WIP on feature/x: wip', at: 450, parent: H('b'), branch: 'feature/x' }],
      hidden: 3,
      skipped: 0,
    },
    ...over,
  }
}

test('the graph puts steps on their branch, folds finished phases, and plans the merge', () => {
  let t = applyPlan(emptyTrail('s1', 0), { phases: plan([['Investigate', 'Check perms', 'doing'], ['Build', 'Writer', 'todo'], ['Ship', 'PR', 'todo']]) }, ctx(50))
  t = applyPlan(t, { phases: plan([['Investigate', 'Check perms', 'done'], ['Build', 'Writer', 'doing'], ['Ship', 'PR', 'todo']]) }, ctx(200))
  t = { ...t, events: [...t.events, { at: 400, kind: 'commit', origin: 'outside', repo: 'r', text: 'hotfix', hash: H('m') }] }
  const view = { trail: t, repo: live(), isPrimary: true, expanded: {}, now: 500, ownerOf: new Map<string, string>() }
  const { list } = items(view)
  const name = (i: (typeof list)[number]) =>
    i.kind === 'step' ? `step:${i.s.title}@${i.lane}` : i.kind === 'phase' ? `phase:${i.title}:${i.isOpen ? 'open' : 'closed'}` : i.kind === 'commit' ? `commit:${i.c.subject}${i.tag ? `(${i.tag})` : ''}` : i.kind
  expect(list.map(name)).toEqual([
    'commit:release',
    'phase:Investigate:closed',
    'phase:Build:open',
    'step:Writer@1',
    'commit:add writer',
    'commit:fix login',
    'commit:hotfix(outside)',
    'stash',
    'dirty',
    'phase:Ship:open',
    'step:PR@1',
    'merge',
  ])
  const { source } = graphSvg(view)
  expect(source).toContain('Investigate<tspan class="phase-sub"> · 1 step done · 1 commit')
  expect(source).toContain('2. Writer · you are here')
  expect(source).toContain('fix/login · also edits auth.ts')
  expect(source).toContain('Merge into main (planned)')
  expect(source).toContain('+3 other branches hidden')
  // Hovering a step shows everything about it.
  expect(source).toContain('<title>2. Writer (doing) · Build · on feature/x')
  expect(graphText(view).some(l => l.text.includes('◉ 2. Writer · you are here'))).toBe(true)

  const opened = items({ ...view, expanded: { [SHOW_ALL]: true } }).list.map(name)
  expect(opened).toContain('step:Check perms@1')
})

test('each step offers the one prompt worth sending', () => {
  const t = applyPlan(emptyTrail('s1', 0), { phases: plan([['P', 'A', 'done'], ['P', 'B', 'doing'], ['P', 'C', 'todo'], ['P', 'D', 'todo']]) }, ctx(1))
  const [a, b, , d] = t.steps
  expect(stepAction(t, a!).label).toBe('Recap')
  expect(stepAction(t, b!).prompt).toBe('Finish step 2 "B", then stop and tell me where we are. Update the Wayfinder plan as you go.')
  expect(stepAction(t, d!).prompt).toBe('Work through the plan up to step 4 "D" (steps 2 to 4), then stop there and tell me where we are. Update the Wayfinder plan as you go.')
  const w = applyPlan(emptyTrail('s2', 0), { phases: [{ title: 'P', steps: [{ title: 'Bench', status: 'doing', waitingOn: 'you', waitingFor: 'run on staging' }] }] }, ctx(1))
  expect(stepAction(w, w.steps[0]!)).toEqual({ label: 'I did it', prompt: 'Done on my side: run on staging. Continue with step 1 "Bench".' })
})

// A fake repo at C:/r on feature/x, one commit ahead of main. `head` moves when the test commits "outside".
function fakeGit(on: On, repo: { head: string; log: string }) {
  on('process.run', (_, e) => {
    const a = e.argv.slice(1).join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const fail = { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const base = H('m')
    if (a === 'rev-parse --show-toplevel') return ok('C:/r')
    if (a === 'symbolic-ref --short HEAD') return ok('feature/x')
    if (a === 'rev-parse HEAD') return ok(repo.head)
    if (a === 'status --porcelain') return ok(' M a.ts\n M b.ts')
    if (a.startsWith('merge-base --is-ancestor')) return ok('')
    if (a.startsWith('log --reverse')) return ok(repo.log)
    if (a === 'rev-parse --verify --quiet refs/heads/main') return ok(base)
    if (a.startsWith('rev-list --left-right --count main...HEAD')) return ok('0\t1')
    if (a.startsWith('for-each-ref')) return ok(`feature/x\t${repo.head}\t900\nmain\t${base}\t800`)
    if (a === 'rev-parse main') return ok(base)
    if (a.startsWith('diff --name-only')) return ok('a.ts')
    if (a.startsWith('merge-base --octopus')) return ok(base)
    if (a.startsWith('log --date-order')) return ok(`${repo.head}\t${base}\t900\tadd writer\n${base}\t\t800\trelease`)
    if (a.startsWith('stash list')) return ok('')
    return fail
  })
}

test('the pane: the graph, the step picker, the details card, and a drafted prompt', async ($, on) => {
  const repo = { head: H('a'), log: '' }
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  fakeGit(on, repo)
  on('session.id', () => ({ value: 's1' }))
  on('tool.register', () => ({ value: { tool: PROGRESS_TOOL } }))
  on('command.register', () => ({ value: { command: 'wayfinder' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  let drafted = ''
  on('prompt.fill', (_, e) => {
    drafted = e.text
    return { isFilled: true }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let seenContext: readonly string[] = []
  on('prompt.submit', (_, e) => {
    seenContext = e.context ?? []
    return { text: e.text, context: e.context }
  })

  await $.session.start({ cwd: 'C:/r', surface: 'desktop', isInteractive: true })
  await clock.advance(16_000)

  const saved = await $.tool.call({
    tool: PROGRESS_TOOL,
    goal: 'Add CSV export',
    whereWasI: 'Writer done, benchmark next.',
    phases: [
      { title: 'Investigate', steps: [{ title: 'Check S3 permissions', status: 'done', note: 'yes, via role X' }] },
      { title: 'Build', steps: [{ title: 'Benchmark on 1M rows', status: 'doing', waitingOn: 'you', waitingFor: 'run it on staging' }, { title: 'Open PR', status: 'todo' }] },
    ],
  })
  expect('deny' in saved).toBe(false)
  const bad = await $.tool.call({ tool: PROGRESS_TOOL, phases: [{ title: 'P', steps: [{ title: 'x', status: 'later' }] }] })
  expect('deny' in bad && bad.deny).toContain('status must be one of')

  // Someone commits on the branch while the session is idle.
  repo.log = `${H('b')}\tadd migration`
  repo.head = H('b')
  await $.prompt.submit({ text: 'where are we?', wait: false, origin: { kind: 'composer' } })
  expect(seenContext.join('\n')).toContain('1 new commit(s) outside this session: bbbbbbb add migration')
  await clock.advance(16_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Add CSV export$/ }))?.text).toBe('Add CSV export')
    // The waiting card and the details card name the step; the graph draws it.
    expect(await ui.find({ type: 'Text', text: /This session: Benchmark on 1M rows: run it on staging/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Waiting on you: run it on staging$/ })).toBeTruthy()
    const graph = async () => (surface === 'terminal' ? (await ui.findAll({ type: 'Text' })).map(x => x.text).join('\n') : String((await ui.find({ type: 'Svg' }))?.props.source))
    expect(await graph()).toContain('2. Benchmark on 1M rows · you are here')
    expect(await graph()).toContain('bbbbbbb add writer')

    // The finished phase is folded into one row until "show finished phases".
    expect(await graph()).not.toContain('1. Check S3 permissions')
    await ui.press({ key: 'show-all' })
    expect(await graph()).toContain('1. Check S3 permissions')
    await ui.press({ key: 'show-all' })

    // The card's action drafts a prompt; it never sends one.
    await ui.press({ key: 'card-action' })
    expect(drafted).toBe('Done on my side: run it on staging. Continue with step 2 "Benchmark on 1M rows".')

    // Picking another step shows its card and its own action.
    await ui.select({ key: 'step-pick', value: 'step:Open PR' })
    expect((await ui.find({ type: 'Button', key: 'card-action' }))?.props.label).toBe('▶ Work up to here')
    await ui.press({ key: 'card-action' })
    expect(drafted).toBe('Work through the plan up to step 3 "Open PR" (steps 2 to 3), then stop there and tell me where we are. Update the Wayfinder plan as you go.')
    await ui.press({ key: 'card-close' })
    await ui.unmount()
  }
})
