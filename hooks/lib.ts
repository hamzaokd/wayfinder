// Pure helpers: no `$`, so the tests can run them directly.
import type { Decision, Step, StepStatus, Trail, TrailEvent } from '../types'
import { T } from './i18n'

export const MAX_EVENTS = 200
const STATUSES: readonly StepStatus[] = ['todo', 'doing', 'done', 'blocked', 'dropped']
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const PROGRESS_TOOL = 'mcp__wayfinder__progress'
export const STUCK_TURNS = 6
const AWAY_MS = 20 * 60_000

export function emptyTrail(sessionId: string, now: number): Trail {
  return {
    sessionId,
    phases: [],
    steps: [],
    decisions: [],
    events: [],
    seen: {},
    turn: 0,
    planTurn: 0,
    planVersion: 0,
    commitsSincePlan: 0,
    pending: [],
    hasNudged: false,
    updatedAt: now,
    lastPromptAt: now,
    unplannedFiles: [],
  }
}

/** Git for Windows prints C:/x; Git Bash paths look like /c/x. Both become C:/x. */
export function normPath(p: string): string {
  const s = p.trim().replace(/^"|"$/g, '').replace(/\\/g, '/')
  const bash = /^\/([a-zA-Z])(\/|$)/.exec(s)
  return bash ? `${bash[1]!.toUpperCase()}:/${s.slice(3)}` : s
}

export function isAbsolute(p: string): boolean {
  return /^[a-zA-Z]:\//.test(p) || p.startsWith('/')
}

export function dirOf(p: string): string {
  const s = normPath(p)
  const i = s.lastIndexOf('/')
  return i <= 0 ? s : s.slice(0, i)
}

export function baseName(p: string): string {
  return normPath(p).split('/').filter(Boolean).at(-1) ?? p
}

/**
 * Folders a tool call points at, so the repos it touched get tracked.
 * shortcut: only absolute paths (file_path, `cd X`, `git -C X`); relative
 * paths need the shell's cwd, which the mod can't see.
 */
export function dirsFromToolUse(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = input[key]
    if (typeof v === 'string' && isAbsolute(normPath(v))) out.push(key === 'path' ? normPath(v) : dirOf(v))
  }
  const cmd = input.command
  if (typeof cmd === 'string') {
    for (const m of cmd.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|[^\s&;|]+)/g)) {
      const p = normPath(m[1]!.replace(/^'|'$/g, ''))
      if (isAbsolute(p)) out.push(p)
    }
    for (const m of cmd.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/g)) {
      const p = normPath(m[1]!.replace(/^'|'$/g, ''))
      if (isAbsolute(p)) out.push(p)
    }
  }
  return out
}

const isOpen = (s: Step) => s.status !== 'done' && s.status !== 'dropped'

export function currentStep(steps: readonly Step[]): Step | undefined {
  return steps.find(s => s.status === 'doing') ?? steps.find(s => s.status === 'blocked') ?? steps.find(s => s.status === 'todo')
}

export function isStuck(trail: Trail, s: Step): boolean {
  return s.status === 'doing' && trail.turn - (s.startedTurn ?? trail.turn) >= STUCK_TURNS
}

export type ChatStatus = { kind: 'blocked' | 'waiting' | 'stuck' | 'achieved' | 'offPlan' | 'doing'; detail?: string }

/** What the strip above the prompt shows, most pressing first; nothing without a plan. Off plan: the plan drifted this turn, or the current step wasn't in it. */
export function chatStatus(t: Trail): ChatStatus | undefined {
  if (t.steps.length === 0) return undefined
  const open = t.steps.filter(s => s.status !== 'done' && s.status !== 'dropped')
  const blocked = open.find(s => s.status === 'blocked')
  if (blocked) return { kind: 'blocked', detail: blocked.title }
  const waiting = open.find(s => s.waitingOn === 'you')
  if (waiting) return { kind: 'waiting', detail: waiting.waitingFor ?? waiting.title }
  const stuck = open.find(s => isStuck(t, s))
  if (stuck) return { kind: 'stuck', detail: stuck.title }
  if (open.length === 0) return t.steps.some(s => s.status === 'done') ? { kind: 'achieved', detail: t.goal } : undefined
  const drift = t.events.filter(e => e.kind === 'drift' && e.at >= t.lastPromptAt).at(-1)
  const cur = currentStep(t.steps)
  if (drift) return { kind: 'offPlan', detail: drift.text }
  if (cur?.addedLate) return { kind: 'offPlan', detail: cur.title }
  return cur && { kind: 'doing', detail: cur.title }
}

export function pushEvents(trail: Trail, events: readonly TrailEvent[]): Trail {
  return events.length === 0 ? trail : { ...trail, events: [...trail.events, ...events].slice(-MAX_EVENTS) }
}

export type PlanInput = { goal?: unknown; whereWasI?: unknown; phases?: unknown; change?: unknown; decisions?: unknown }
/** `isMirror`: the input mirrors Claude's own task list (taskListPlan): no drift, no reason asked. */
export type PlanCtx = { now: number; repo?: string; branch?: string; isMirror?: boolean }

const str = (v: unknown, name: string, max: number): string | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  return v.trim().slice(0, max) || undefined
}

type Parsed = Pick<Step, 'title' | 'phase' | 'status' | 'note' | 'waitingOn' | 'waitingFor' | 'detail'>

function parsePhases(raw: unknown): { phases: string[]; steps: Parsed[] } {
  if (!Array.isArray(raw)) throw new Error('phases must be an array of { title, steps }')
  if (raw.length === 0 || raw.length > 12) throw new Error('send 1 to 12 phases')
  const phases: string[] = []
  const steps: Parsed[] = []
  raw.forEach((p, i) => {
    const ph = p as Record<string, unknown>
    const title = str(ph?.title, `phases[${i}].title`, 60)
    if (!title) throw new Error(`phases[${i}].title is required`)
    if (phases.includes(title)) throw new Error(`phase "${title}" appears twice`)
    phases.push(title)
    if (!Array.isArray(ph.steps) || ph.steps.length === 0) throw new Error(`phases[${i}].steps must be a non-empty array`)
    ph.steps.forEach((s0, j) => {
      const s = s0 as Record<string, unknown>
      const at = `phases[${i}].steps[${j}]`
      const stepTitle = str(s?.title, `${at}.title`, 160)
      if (!stepTitle) throw new Error(`${at}.title is required`)
      if (!STATUSES.includes(s.status as StepStatus)) throw new Error(`${at}.status must be one of ${STATUSES.join(', ')}`)
      if (s.waitingOn !== undefined && s.waitingOn !== 'you' && s.waitingOn !== 'claude') throw new Error(`${at}.waitingOn must be "you" or "claude"`)
      steps.push({
        title: stepTitle,
        phase: title,
        status: s.status as StepStatus,
        note: str(s.note, `${at}.note`, 300),
        waitingOn: s.waitingOn as Step['waitingOn'],
        waitingFor: str(s.waitingFor, `${at}.waitingFor`, 160),
        detail: str(s.detail, `${at}.detail`, 300),
      })
    })
  })
  if (steps.length > 40) throw new Error('at most 40 steps')
  const seen = new Set<string>()
  for (const s of steps) {
    if (seen.has(s.title)) throw new Error(`step "${s.title}" appears twice: step titles must be unique`)
    seen.add(s.title)
  }
  return { phases, steps }
}

/**
 * Validates what the model sent (a trust boundary) and applies it. Throws with
 * a message the model reads. Changes against the previous plan (steps added,
 * dropped or reordered) need `change.reason`: that is what makes drift visible.
 */
export function applyPlan(trail: Trail, input: PlanInput, ctx: PlanCtx): Trail {
  const { now } = ctx
  const goal = str(input.goal, 'goal', 200)
  const whereWasI = str(input.whereWasI, 'whereWasI', 400)
  const change = input.change as Record<string, unknown> | undefined
  const reason = str(change?.reason, 'change.reason', 300)
  const events: TrailEvent[] = []
  // A mirrored task list is not a plan Claude committed to: its changes are not drift.
  const drift = (text: string, step?: string) => void (ctx.isMirror || events.push({ at: now, kind: 'drift', origin: 'session', repo: '', text, step }))

  let { phases, steps } = trail
  if (input.phases !== undefined) {
    const next = parsePhases(input.phases)
    const prev = new Map(trail.steps.map(s => [s.title, s]))
    const isFirstPlan = trail.planVersion === 0 || trail.steps.length === 0
    const prevLive = trail.steps.filter(s => s.status !== 'dropped').map(s => s.title)
    const nextTitles = new Set(next.steps.map(s => s.title))
    const added = isFirstPlan || ctx.isMirror ? [] : next.steps.filter(s => !prev.has(s.title)).map(s => s.title)
    const removed = trail.steps.filter(s => s.status !== 'dropped' && s.status !== 'done' && !nextTitles.has(s.title)).map(s => s.title)
    const newlyDropped = next.steps.filter(s => s.status === 'dropped' && prev.get(s.title)?.status !== 'dropped').map(s => s.title)
    const common = next.steps.map(s => s.title).filter(t => prevLive.includes(t))
    const prevOrder = prevLive.filter(t => common.includes(t))
    const isReordered = !isFirstPlan && common.join('\n') !== prevOrder.join('\n')
    const isChanged = added.length > 0 || removed.length > 0 || (!isFirstPlan && newlyDropped.length > 0) || isReordered
    if (isChanged && !reason && !ctx.isMirror) {
      const what = [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : '', newlyDropped.length ? `dropped ${newlyDropped.join(', ')}` : '', isReordered ? 'reordered steps' : ''].filter(Boolean).join('; ')
      throw new Error(`the plan changed (${what}): say why in change.reason`)
    }
    const merged: Step[] = next.steps.map(n => {
      const p = prev.get(n.title)
      const s: Step = { ...p, ...n, files: p?.files ?? [], addedLate: p?.addedLate ?? (added.includes(n.title) || undefined), reason: p?.reason }
      if (added.includes(n.title)) {
        s.reason = reason
        drift(`Added "${n.title}": ${reason}`, n.title)
      }
      if (n.status === 'doing' && p?.status !== 'doing') Object.assign(s, { startedAt: now, startedTurn: trail.turn, repo: ctx.repo ?? s.repo, branch: ctx.branch ?? s.branch })
      if (n.status === 'done' && p?.status !== 'done') {
        Object.assign(s, { doneAt: now, startedAt: s.startedAt ?? now, repo: s.repo ?? ctx.repo, branch: s.branch ?? ctx.branch })
        events.push({ at: now, kind: 'step', origin: 'session', repo: '', text: `Done: ${n.title}${n.note ? `: ${n.note}` : ''}`, step: n.title })
      }
      if (n.status === 'dropped' && p?.status !== 'dropped') {
        Object.assign(s, { doneAt: now, reason: reason ?? n.note })
        if (!isFirstPlan) drift(`Dropped "${n.title}": ${reason ?? n.note ?? ''}`, n.title)
      }
      return s
    })
    // A step left out of the new plan isn't forgotten: it stays, dropped, with the reason.
    for (const title of removed) {
      const p = prev.get(title)!
      merged.push({ ...p, status: 'dropped', doneAt: now, reason })
      drift(`Dropped "${title}": ${reason}`, title)
    }
    if (isReordered) drift(`Reordered the plan: ${reason}`)
    // Done while an earlier step is still todo: out of order.
    merged.forEach((s, i) => {
      const wasDone = prev.get(s.title)?.status === 'done'
      if (!ctx.isMirror && s.status === 'done' && !wasDone && merged.slice(0, i).some(e => e.status === 'todo')) {
        s.outOfOrder = true
        drift(`"${s.title}" was done before earlier steps`, s.title)
      }
    })
    const keptPhases = [...next.phases, ...trail.phases.filter(p => !next.phases.includes(p) && merged.some(s => s.phase === p))]
    phases = keptPhases
    steps = merged
  }

  let decisions = trail.decisions
  if (input.decisions !== undefined) {
    if (!Array.isArray(input.decisions)) throw new Error('decisions must be an array of { text, why }')
    const doing = currentStep(steps)?.title
    const fresh: Decision[] = input.decisions.map((d0, i) => {
      const d = d0 as Record<string, unknown>
      const text = str(d?.text, `decisions[${i}].text`, 200)
      if (!text) throw new Error(`decisions[${i}].text is required`)
      return { at: now, text, why: str(d.why, `decisions[${i}].why`, 300), step: doing, repo: ctx.repo, branch: ctx.branch }
    })
    decisions = [...decisions, ...fresh].slice(-60)
  }

  return pushEvents(
    {
      ...trail,
      goal: goal ?? trail.goal,
      whereWasI: whereWasI ?? trail.whereWasI,
      phases,
      steps,
      decisions,
      planVersion: input.phases !== undefined ? trail.planVersion + 1 : trail.planVersion,
      planTurn: trail.turn,
      commitsSincePlan: 0,
      updatedAt: now,
    },
    events,
  )
}

export type ToolUseLite = { tool: string; input: Record<string, unknown> }

function doingIn(input: Record<string, unknown>): string | undefined {
  if (!Array.isArray(input.phases)) return undefined
  for (const p of input.phases as { steps?: { title?: unknown; status?: unknown }[] }[]) {
    for (const s of p?.steps ?? []) if (s?.status === 'doing' && typeof s.title === 'string') return s.title.trim()
  }
  return undefined
}

/**
 * Walks Claude's tool calls in order and files each edited path under the step
 * that was current at that moment, so one big commit still reads step by step.
 * shortcut: only Edit/Write/MultiEdit/NotebookEdit count; files changed by shell commands are not attributed.
 */
export function attributeEdits(trail: Trail, uses: readonly ToolUseLite[], roots: readonly string[]): Trail {
  let active = trail.activeStep
  let lastRepo = trail.lastRepo
  const files = new Map(trail.steps.map(s => [s.title, new Set(s.files)]))
  const unplanned = new Set(trail.unplannedFiles)
  for (const use of uses) {
    if (use.tool === PROGRESS_TOOL) {
      const doing = doingIn(use.input)
      if (doing !== undefined || Array.isArray(use.input.phases)) active = doing
      continue
    }
    if (!EDIT_TOOLS.has(use.tool)) continue
    const raw = use.input.file_path ?? use.input.notebook_path
    if (typeof raw !== 'string') continue
    const path = normPath(raw)
    lastRepo = roots.find(r => path.toLowerCase().startsWith(`${r.toLowerCase()}/`)) ?? lastRepo
    const bucket = active !== undefined ? files.get(active) : undefined
    if (bucket) bucket.add(path)
    else unplanned.add(path)
  }
  return {
    ...trail,
    activeStep: active,
    lastRepo,
    steps: trail.steps.map(s => ({ ...s, files: [...(files.get(s.title) ?? [])].slice(-40) })),
    unplannedFiles: [...unplanned].slice(-40),
  }
}

/**
 * A session with no saved plan (a fork, or a store that lost it) replays the
 * plan updates its own conversation already holds, in order, so it carries on
 * the plan instead of starting empty. Calls that were refused are skipped.
 */
export function rebuildFromHistory(trail: Trail, uses: readonly (ToolUseLite & { isError?: boolean })[], roots: readonly string[], now: number): Trail {
  let out = trail
  for (const use of uses) {
    if (use.tool !== PROGRESS_TOOL || use.isError) continue
    try {
      out = applyPlan(out, use.input, { now })
    } catch {
      // A call the validation of today refuses (it changed since): replaying the rest still beats an empty plan.
      continue
    }
  }
  return out.planVersion === 0 ? trail : attributeEdits(out, uses, roots)
}

/** Files this session edited that another session, active in the last day, edited too. */
export type Overlap = { sessionId: string; session: string; files: string[] }

const OVERLAP_MS = 24 * 3_600_000

/**
 * A trail's edited files, keyed by repo folder name and repo-relative path, so two checkouts of
 * a repo at the same folder name match. shortcut: worktrees of one repo under different folder
 * names are not matched; compare by git's common dir if that matters.
 */
function editedFiles(t: Trail): Map<string, string> {
  const roots = Object.keys(t.seen)
  const out = new Map<string, string>()
  for (const f of [...t.steps.flatMap(s => s.files), ...t.unplannedFiles]) {
    const root = roots.find(r => f.startsWith(`${r}/`))
    const rel = root ? f.slice(root.length + 1) : f
    out.set(root ? `${repoName(root)}:${rel}` : f, rel)
  }
  return out
}

export function sharedFiles(self: Trail, others: readonly Trail[], now: number): Overlap[] {
  const mine = editedFiles(self)
  return others
    .filter(o => now - o.updatedAt < OVERLAP_MS)
    .map(o => ({ sessionId: o.sessionId, session: o.goal ?? T.anotherSession, files: [...editedFiles(o).keys()].filter(k => mine.has(k)).map(k => mine.get(k)!) }))
    .filter(o => o.files.length > 0)
}

export type WaitingItem = { sessionId: string; session: string; isSelf: boolean; related?: 'repo' | 'topic'; step: string; what?: string; link?: string }

/** Waits the user cleared from a pane, shared by every session: `sessionId\0step title` -> when. */
export type Cleared = Record<string, number>
export const clearKey = (sessionId: string, step: string) => `${sessionId}\u0000${step}`

/** The desktop app's link to a session, from its own id; none for a terminal session or an id of another shape. */
export const sessionLink = (hostId?: string) => (hostId && /^local_[0-9a-f-]{36}$/.test(hostId) ? `claude://claude.ai/epitaxy/${hostId}` : undefined)

// Words too common in goals to say two sessions share a topic (EN and FR).
const COMMON = new Set('with from into that this make build when then also session sessions plan step steps work avec dans pour plus sans être faire une des les'.split(' '))
const goalWords = (goal?: string) => new Set((goal ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4 && !COMMON.has(w)))

/** How another session relates to this one: a repo both worked in, else two words their goals share. */
export function relation(self: Trail, o: Trail): 'repo' | 'topic' | undefined {
  if (Object.keys(o.seen).some(r => r in self.seen)) return 'repo'
  const mine = goalWords(self.goal)
  // shortcut: word overlap of the goals, so a topic named in other words is missed; ask the model if that grates.
  return [...goalWords(o.goal)].filter(w => mine.has(w)).length >= 2 ? 'topic' : undefined
}

/** Every open step, in every session, that waits on the user, less the ones they cleared. This session first, then same repo, then same topic. */
export function waitingOnYou(self: Trail, others: readonly Trail[], cleared: Cleared = {}): WaitingItem[] {
  const rank = { repo: 0, topic: 1, none: 2 }
  const rel = new Map(others.map(o => [o, relation(self, o)]))
  const sorted = [...others].sort((a, b) => rank[rel.get(a) ?? 'none'] - rank[rel.get(b) ?? 'none'])
  return [self, ...sorted].flatMap(t =>
    t.steps
      .filter(s => isOpen(s) && s.waitingOn === 'you' && !(clearKey(t.sessionId, s.title) in cleared))
      .map(s => ({ sessionId: t.sessionId, session: t.goal ?? T.noGoal, isSelf: t === self, related: rel.get(t), step: s.title, what: s.waitingFor, link: sessionLink(t.hostId) })),
  )
}

/** This session's cleared waits taken off its steps, with a note for Claude; `done` are the keys it handled. */
export function applyCleared(t: Trail, cleared: Cleared): { trail: Trail; done: string[] } {
  const done = Object.keys(cleared).filter(k => k.startsWith(`${t.sessionId}\u0000`))
  const titles = new Set(done.map(k => k.slice(t.sessionId.length + 1)))
  const hit = t.steps.filter(s => titles.has(s.title) && s.waitingOn === 'you')
  if (!hit.length) return { trail: t, done }
  return {
    trail: {
      ...t,
      steps: t.steps.map(s => (hit.includes(s) ? { ...s, waitingOn: undefined, waitingFor: undefined } : s)),
      pending: [...t.pending, ...hit.map(s => `The user cleared the wait on step ${quoted(s.title)} in the Wayfinder pane: they did it outside Claude, or it no longer matters. Don't ask for it again; update the step with ${PROGRESS_TOOL}.`)].slice(-10),
    },
    done,
  }
}

export type StashLite = { at: number; subject: string }

/** What changed while the user was away (20 minutes or more since their last message), or nothing. */
export function sinceYouLeft(trail: Trail, others: readonly Trail[], stashes: readonly StashLite[], now: number): { away: string; lines: string[]; next?: string } | undefined {
  const since = trail.lastPromptAt
  if (now - since < AWAY_MS) return undefined
  const fresh = trail.events.filter(e => e.at > since)
  const lines: string[] = []
  const count = (kind: TrailEvent['kind'], origin: TrailEvent['origin']) => fresh.filter(e => e.kind === kind && e.origin === origin)
  const outside = count('commit', 'outside')
  if (outside.length) lines.push(T.awayOutsideCommits(outside.length, [...new Set(outside.map(e => e.repo))].join(', ')))
  const own = count('commit', 'session')
  if (own.length) lines.push(T.awayClaudeCommits(own.length))
  const done = fresh.filter(e => e.kind === 'step')
  if (done.length) lines.push(T.awayStepsDone(done.map(e => e.step).join(', ')))
  const drifted = fresh.filter(e => e.kind === 'drift')
  if (drifted.length) lines.push(T.awayPlanChanged(drifted.length))
  if (fresh.some(e => e.kind === 'rewrite')) lines.push(T.awayRewritten)
  const switched = fresh.filter(e => e.kind === 'branch')
  if (switched.length) lines.push(T.awaySwitched(switched.at(-1)!.text))
  const newStashes = stashes.filter(s => s.at > since)
  if (newStashes.length) lines.push(T.awayStashes(newStashes.length))
  for (const o of others) {
    if (o.updatedAt <= since) continue
    const cur = currentStep(o.steps)
    lines.push(T.awayOther(o.goal ?? T.anotherSession, cur?.title))
  }
  const mins = Math.round((now - since) / 60_000)
  const away = T.awayFor(mins)
  const cur = currentStep(trail.steps)
  return { away, lines: lines.length ? lines : [T.nothingChanged], next: cur ? `${cur.title}${cur.waitingOn === 'you' ? T.waitingSuffix : ''}` : trail.whereWasI }
}

/**
 * What a click on a step offers. `main` is sent to this session, where the work
 * happens; `side` is a side question answered in the pane (like /btw), never
 * added to the chat; `mark` flips the step done or not.
 */
export type MenuOption = { label: string; kind: 'main' | 'side' | 'mark'; prompt?: string }

/** A step's number as phase.step ("2.3"): its phase's place in the plan, then its place in that phase. */
export function stepNo(trail: Trail, s: Step): string {
  return `${trail.phases.indexOf(s.phase) + 1}.${trail.steps.filter(x => x.phase === s.phase).indexOf(s) + 1}`
}

export function stepMenu(trail: Trail, s: Step, now: number): { header: string; question: string; options: MenuOption[] } {
  const n = stepNo(trail, s)
  // Step text was written by Claude: inside a prompt it stays one quoted line, never loose instructions.
  const name = T.stepName(n, quoted(s.title))
  const isOpen = s.status !== 'done' && s.status !== 'dropped'
  const when = s.doneAt ? (s.status === 'dropped' ? T.droppedAgo : T.doneAgo)(ago(now - s.doneAt)) : s.startedAt ? T.startedAgo(ago(now - s.startedAt)) : T.notStarted
  const lines = [
    `${n} ${s.title} (${T.status[s.status] ?? s.status}, ${when})`,
    s.detail ?? '',
    s.note ? T.result(s.note) : '',
    isOpen && s.waitingOn ? T.waitingOn(s.waitingOn, s.waitingFor) : '',
    s.addedLate ? T.notInFirstPlan(s.reason ?? T.noReason) : '',
    s.status === 'dropped' ? T.droppedBecause(s.reason ?? T.noReason) : '',
    s.files.length ? T.files(`${s.files.slice(0, 8).map(baseName).join(', ')}${s.files.length > 8 ? ` +${s.files.length - 8}` : ''}`) : '',
    T.whatToDo,
  ]
  const options: MenuOption[] = []
  if (s.status === 'done') {
    options.push({ label: T.recap, kind: 'side', prompt: T.pRecap(name) })
    options.push({ label: T.markNotDone, kind: 'mark' })
  } else if (s.status === 'dropped') {
    options.push({ label: T.bringBack, kind: 'main', prompt: T.pBringBack(name, quoted(s.reason ?? T.noReason)) })
    options.push({ label: T.whyDropped, kind: 'side', prompt: T.pWhyDropped(name) })
  } else {
    const open = trail.steps.filter(x => x.status !== 'done' && x.status !== 'dropped')
    const first = open[0]
    if (s.waitingOn === 'you') options.push({ label: T.didMyPart, kind: 'main', prompt: T.pDidMyPart(quoted(s.waitingFor ?? s.title), name) })
    else if (s.status === 'doing' || first === s) options.push({ label: T.continueStep, kind: 'main', prompt: T.pContinue(name) })
    else {
      const from = first ? stepNo(trail, first) : n
      options.push({ label: T.workUpTo, kind: 'main', prompt: T.pWorkUpTo(name, from, n) })
    }
    options.push({ label: T.explain, kind: 'side', prompt: T.pExplain(name) })
    options.push({ label: T.markDone, kind: 'mark' })
  }
  return { header: T.stepHeader(n), question: lines.filter(Boolean).join('\n'), options }
}

/** Text from git (names, commit subjects) as one short quoted string: newlines escaped, 80 characters at most. */
export function quoted(s: string): string {
  return JSON.stringify(s.length > 80 ? `${s.slice(0, 79)}…` : s)
}

export function ago(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 1) return T.justNow
  if (m < 60) return T.minutesAgo(m)
  const h = Math.floor(m / 60)
  return h < 24 ? T.hoursAgo(h) : T.daysAgo(Math.floor(h / 24))
}

/** An age in a few characters ("35m", "8h", "4d"), for a column of them. */
export function agoShort(ms: number): string {
  const m = Math.floor(ms / 60000)
  const u = T.ageShort
  if (m < 1) return u.now
  if (m < 60) return `${m}${u.m}`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}${u.h}` : `${Math.floor(h / 24)}${u.d}`
}

export function repoName(root: string): string {
  return root.split('/').filter(Boolean).at(-1) ?? root
}

const TASK_STATUS: Record<string, StepStatus> = { pending: 'todo', in_progress: 'doing', completed: 'done' }
type TaskStep = { title: string; status: StepStatus }

/**
 * The task list Claude keeps anyway, as plan input (applied with `isMirror`): the desktop app's
 * update_plan (a whole list, or advance / done / start) and wrap_up (its recap is "where we are"), or
 * Claude Code's TodoWrite. Each new list is a phase, "Request n"; what the previous one left open is
 * dropped. Undefined when the call changes nothing.
 */
export function taskListPlan(trail: Trail, tool: string, args: Record<string, unknown>): PlanInput | undefined {
  const phases = (trail.planFrom === 'tasks' ? trail.phases : []).map(title => ({ title, steps: trail.steps.filter(s => s.phase === title).map((s): TaskStep => ({ title: s.title, status: s.status })) }))
  const cur = phases.at(-1)
  const isOpen = (s: TaskStep) => s.status === 'todo' || s.status === 'doing'
  const raw = tool === 'TodoWrite' ? args.todos : args.items
  if (Array.isArray(raw)) {
    const list = raw.flatMap((x): TaskStep[] => {
      const o = x as Record<string, unknown> | null
      const title = typeof o?.content === 'string' ? o.content.trim().slice(0, 160) : ''
      const status = TASK_STATUS[String(o?.status)]
      return title && status ? [{ title, status }] : []
    })
    if (list.length === 0) return undefined
    // A list sharing a step with the current one revises it; any other starts the next request.
    // A revision keeps the steps already done that it leaves out: they happened.
    if (cur && list.some(i => cur.steps.some(s => s.title === i.title))) cur.steps = [...cur.steps.filter(s => s.status === 'done' && !list.some(i => i.title === s.title)), ...list]
    else {
      if (cur) cur.steps = cur.steps.map(s => (isOpen(s) ? { ...s, status: 'dropped' } : s))
      const n = 1 + Math.max(0, ...phases.map(p => Number(/\d+$/.exec(p.title)?.[0] ?? 0)))
      phases.push({ title: T.request(n), steps: list })
    }
  } else if (cur) {
    const steps = cur.steps
    if (tool.endsWith('wrap_up')) {
      for (const s of steps) if (s.status === 'doing') s.status = 'done'
    } else {
      if (args.advance === true) {
        const doing = steps.find(s => s.status === 'doing')
        if (doing) doing.status = 'done'
        const next = steps.find(s => s.status === 'todo')
        if (next) next.status = 'doing'
      }
      for (const k of Array.isArray(args.done) ? args.done : []) if (steps[Number(k) - 1]) steps[Number(k) - 1]!.status = 'done'
      const start = steps[Number(args.start) - 1]
      if (start) start.status = 'doing'
    }
  } else return undefined
  // Titles are a step's identity across the plan: a later list's "Run tests" must not take an earlier one's place.
  const seen = new Set<string>()
  const unique = phases.map((p, pi) => ({ title: p.title, steps: p.steps.map(s => ({ ...s, title: seen.has(s.title) ? `${s.title} (${pi + 1})` : (seen.add(s.title), s.title) })) }))
  // shortcut: the newest phases that fit the plan's limits (12 phases, 40 steps); older requests fall off. Keep them elsewhere if they are missed.
  const kept: typeof unique = []
  let count = 0
  for (const p of [...unique].reverse()) {
    if (kept.length === 12 || count + p.steps.length > 40) break
    kept.unshift(p)
    count += p.steps.length
  }
  if (kept.length === 0) return undefined
  const recap = tool.endsWith('wrap_up') && typeof args.recap === 'string' ? args.recap : undefined
  return { phases: kept, ...(recap ? { whereWasI: recap } : {}) }
}
