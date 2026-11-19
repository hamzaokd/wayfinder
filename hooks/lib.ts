// Pure helpers: no `$`, so the tests can run them directly.
import type { Decision, Step, StepStatus, Trail, TrailEvent } from '../types'

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

export function pushEvents(trail: Trail, events: readonly TrailEvent[]): Trail {
  return events.length === 0 ? trail : { ...trail, events: [...trail.events, ...events].slice(-MAX_EVENTS) }
}

export type PlanInput = { goal?: unknown; whereWasI?: unknown; phases?: unknown; change?: unknown; decisions?: unknown }
export type PlanCtx = { now: number; repo?: string; branch?: string }

const str = (v: unknown, name: string, max: number): string | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  return v.trim().slice(0, max) || undefined
}

type Parsed = Pick<Step, 'title' | 'phase' | 'status' | 'note' | 'waitingOn' | 'waitingFor'>

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
  const drift = (text: string, step?: string) => events.push({ at: now, kind: 'drift', origin: 'session', repo: '', text, step })

  let { phases, steps } = trail
  if (input.phases !== undefined) {
    const next = parsePhases(input.phases)
    const prev = new Map(trail.steps.map(s => [s.title, s]))
    const isFirstPlan = trail.planVersion === 0 || trail.steps.length === 0
    const prevLive = trail.steps.filter(s => s.status !== 'dropped').map(s => s.title)
    const nextTitles = new Set(next.steps.map(s => s.title))
    const added = isFirstPlan ? [] : next.steps.filter(s => !prev.has(s.title)).map(s => s.title)
    const removed = trail.steps.filter(s => s.status !== 'dropped' && s.status !== 'done' && !nextTitles.has(s.title)).map(s => s.title)
    const newlyDropped = next.steps.filter(s => s.status === 'dropped' && prev.get(s.title)?.status !== 'dropped').map(s => s.title)
    const common = next.steps.map(s => s.title).filter(t => prevLive.includes(t))
    const prevOrder = prevLive.filter(t => common.includes(t))
    const isReordered = !isFirstPlan && common.join('\n') !== prevOrder.join('\n')
    const isChanged = added.length > 0 || removed.length > 0 || (!isFirstPlan && newlyDropped.length > 0) || isReordered
    if (isChanged && !reason) {
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
      if (s.status === 'done' && !wasDone && merged.slice(0, i).some(e => e.status === 'todo')) {
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

export type WaitingItem = { session: string; isSelf: boolean; step: string; what?: string }

/** Every open step, in every session, that waits on the user. */
export function waitingOnYou(self: Trail, others: readonly Trail[]): WaitingItem[] {
  return [self, ...others].flatMap(t =>
    t.steps
      .filter(s => isOpen(s) && s.waitingOn === 'you')
      .map(s => ({ session: t.goal ?? '(no goal yet)', isSelf: t === self, step: s.title, what: s.waitingFor })),
  )
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
  if (outside.length) lines.push(`${outside.length} commit(s) outside this session: ${[...new Set(outside.map(e => e.repo))].join(', ')}`)
  const own = count('commit', 'session')
  if (own.length) lines.push(`Claude made ${own.length} commit(s)`)
  const done = fresh.filter(e => e.kind === 'step')
  if (done.length) lines.push(`Steps finished: ${done.map(e => e.step).join(', ')}`)
  const drifted = fresh.filter(e => e.kind === 'drift')
  if (drifted.length) lines.push(`Plan changed ${drifted.length} time(s)`)
  if (fresh.some(e => e.kind === 'rewrite')) lines.push('Branch history was rewritten')
  const switched = fresh.filter(e => e.kind === 'branch')
  if (switched.length) lines.push(`Branch switched: ${switched.at(-1)!.text}`)
  const newStashes = stashes.filter(s => s.at > since)
  if (newStashes.length) lines.push(`${newStashes.length} new stash(es)`)
  for (const o of others) {
    if (o.updatedAt <= since) continue
    const cur = currentStep(o.steps)
    lines.push(`"${o.goal ?? 'another session'}" moved on${cur ? `: now on ${cur.title}` : ''}`)
  }
  const mins = Math.round((now - since) / 60_000)
  const away = mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`
  const cur = currentStep(trail.steps)
  return { away, lines: lines.length ? lines : ['Nothing changed.'], next: cur ? `${cur.title}${cur.waitingOn === 'you' ? ' (waiting on you)' : ''}` : trail.whereWasI }
}

/**
 * The one thing worth doing from a step, as a draft prompt: work up to it,
 * say you did your part, recap it, or bring it back.
 */
export function stepAction(trail: Trail, s: Step): { label: string; prompt: string } {
  const n = trail.steps.indexOf(s) + 1
  const name = `step ${n} "${s.title}"`
  if (s.status === 'done') {
    const files = s.files.length ? ` (${s.files.slice(0, 6).map(baseName).join(', ')})` : ''
    return { label: 'Recap', prompt: `Recap ${name}: what changed${files}, what we decided, and anything left open.` }
  }
  if (s.status === 'dropped') return { label: 'Bring back', prompt: `Bring back ${name} (dropped: ${s.reason ?? 'no reason given'}). Put it back in the plan and say where it fits.` }
  if (s.waitingOn === 'you') return { label: 'I did it', prompt: `Done on my side: ${s.waitingFor ?? s.title}. Continue with ${name}.` }
  const open = trail.steps.filter(x => x.status !== 'done' && x.status !== 'dropped')
  const first = open[0]
  if (s.status === 'doing' || first === s) return { label: '▶ Finish this step', prompt: `Finish ${name}, then stop and tell me where we are. Update the Wayfinder plan as you go.` }
  const from = first ? trail.steps.indexOf(first) + 1 : n
  return { label: '▶ Work up to here', prompt: `Work through the plan up to ${name} (steps ${from} to ${n}), then stop there and tell me where we are. Update the Wayfinder plan as you go.` }
}

export function ago(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

export function repoName(root: string): string {
  return root.split('/').filter(Boolean).at(-1) ?? root
}
