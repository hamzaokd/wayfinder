// The branch graph with the session's plan on it: lanes are branches, time runs down,
// phases are blocks, steps sit on the branch where they ran, todo steps continue dashed.
// Drawn as rows: a slice of the lane drawing beside native, clickable text.
import type { GraphCommit, Lane, RepoLive, Step, Trail } from '../types'
import { T } from './i18n'
import { ago, isStuck, stepNo } from './lib'

export type GraphView = {
  trail: Trail
  repo: RepoLive
  /** The repo new and future steps belong to. */
  isPrimary: boolean
  expanded: Readonly<Record<string, boolean>>
  now: number
  /** Commit hash -> the goal of the other session that made it. */
  ownerOf: ReadonlyMap<string, string>
}

export type PhaseState = 'done' | 'current' | 'future'

export type Item = { t: number; o: number; lane: number; phase?: string } & (
  | { kind: 'commit'; c: GraphCommit; tag?: string; isOwn: boolean; isCompact: boolean; label?: string }
  | { kind: 'step'; s: Step; index: number }
  | { kind: 'decision'; text: string; why?: string }
  | { kind: 'stash'; name: string; subject: string; at: number; isFaded: boolean }
  | { kind: 'dirty'; count: number }
  | { kind: 'phase'; title: string; state: PhaseState; isOpen: boolean; summary: string }
  | { kind: 'merge'; into: string }
)

export function phaseState(steps: readonly Step[]): PhaseState {
  const live = steps.filter(s => s.status !== 'dropped')
  if (live.length > 0 && live.every(s => s.status === 'done')) return 'done'
  if (live.some(s => s.status !== 'todo')) return 'current'
  return steps.every(s => s.status === 'dropped') ? 'done' : 'future'
}

/** A click on a phase flips it; until then finished phases are folded and the rest are open. */
export function isPhaseOpen(title: string, state: PhaseState, expanded: Readonly<Record<string, boolean>>): boolean {
  return expanded[title] ?? state !== 'done'
}


/** Everything the graph draws, in drawing order. */
export function items(v: GraphView): { list: Item[]; lanes: Lane[]; current: number } {
  const { trail, repo, now } = v
  const graph = repo.graph
  const lanes = graph?.lanes.length ? graph.lanes : [{ branch: repo.branch, relevance: 1, why: 'current', isCurrent: true, tip: repo.head }]
  const current = Math.max(0, lanes.findIndex(l => l.isCurrent))
  const laneOfBranch = (b?: string) => {
    const i = b === undefined ? -1 : lanes.findIndex(l => l.branch === b || l.branch === `origin/${b}`)
    return i === -1 ? current : i
  }
  const mine = (s: Step) => (s.repo ? s.repo === repo.root : v.isPrimary)
  const steps = trail.steps.map((s, index) => ({ s, index })).filter(({ s }) => mine(s))
  const commits = graph?.commits ?? []

  const phases = trail.phases.map((title, pi) => {
    const own = trail.steps.filter(s => s.phase === title)
    const state = phaseState(own)
    // A step dropped before it ever started says nothing about when its phase ran.
    // Steps back at todo (started, then reset) don't count either: the phase sits with the future.
    const starts = own.filter(s => s.status !== 'todo' && (s.status !== 'dropped' || s.startedAt !== undefined)).map(s => s.startedAt ?? s.doneAt).filter((x): x is number => x !== undefined)
    const ends = own.map(s => s.doneAt).filter((x): x is number => x !== undefined)
    return {
      title,
      pi,
      state,
      isOpen: isPhaseOpen(title, state, v.expanded),
      start: starts.length ? Math.min(...starts) : Infinity,
      end: state === 'done' ? (ends.length ? Math.max(...ends) : -Infinity) : Infinity,
      count: own.filter(s => s.status === 'done').length,
      total: own.filter(s => s.status !== 'dropped').length,
    }
  })
  const phaseAt = (t: number) => phases.find(p => p.start !== Infinity && p.start <= t && t <= p.end)
  const closed = new Set(phases.filter(p => !p.isOpen).map(p => p.title))

  const own = new Set(trail.events.filter(e => e.kind === 'commit' && e.origin === 'session' && e.hash).map(e => e.hash))
  const outside = new Set(trail.events.filter(e => e.kind === 'commit' && e.origin === 'outside' && e.hash).map(e => e.hash))
  const list: Item[] = []

  const tipOf = new Map(lanes.map((l, i) => [i, commits.filter(c => c.lane === i).at(-1)?.hash]))
  for (const c of commits) {
    const lane = lanes[c.lane]
    if (!lane) continue
    const owner = v.ownerOf.get(c.hash)
    const tag = owner ? T.fromSession(owner) : outside.has(c.hash) ? T.outside : undefined
    const phase = phaseAt(c.at)?.title
    const isSide = !lane.isBase && !lane.isCurrent
    const isTip = tipOf.get(c.lane) === c.hash
    const isCompact = (phase !== undefined && closed.has(phase)) || (isSide && lane.relevance < 1 && !isTip && !tag)
    const label = isSide && isTip ? `${lane.branch} · ${lane.why}` : undefined
    list.push({ kind: 'commit', t: c.at, o: 1, lane: c.lane, phase, c, tag, isOwn: own.has(c.hash), isCompact, label })
  }

  for (const { s, index } of steps) {
    if (closed.has(s.phase)) continue
    const isFuture = s.status === 'todo' || (s.status === 'dropped' && s.startedAt === undefined && phases.find(p => p.title === s.phase)?.state === 'future')
    const t = isFuture ? Infinity : (s.status === 'done' || s.status === 'dropped' ? s.doneAt : s.startedAt) ?? now
    const lane = isFuture ? current : laneOfBranch(s.branch)
    list.push({ kind: 'step', t, o: 1000 + phases.findIndex(p => p.title === s.phase) * 100 + index, lane, phase: s.phase, s, index })
  }

  for (const d of trail.decisions) {
    if (d.repo ? d.repo !== repo.root : !v.isPrimary) continue
    const phase = trail.steps.find(s => s.title === d.step)?.phase ?? phaseAt(d.at)?.title
    if (phase !== undefined && closed.has(phase)) continue
    list.push({ kind: 'decision', t: d.at, o: 2, lane: laneOfBranch(d.branch), phase, text: d.text, why: d.why })
  }

  for (const st of graph?.stashes ?? []) {
    const onLane = commits.find(c => c.hash === st.parent)?.lane
    list.push({ kind: 'stash', t: st.at, o: 3, lane: onLane ?? laneOfBranch(st.branch), phase: phaseAt(st.at)?.title, name: st.name, subject: st.subject, at: st.at, isFaded: st.branch !== repo.branch })
  }

  if (repo.dirty > 0) list.push({ kind: 'dirty', t: now, o: 4, lane: current, count: repo.dirty, phase: phaseAt(now)?.title })

  for (const p of phases) {
    if (!steps.some(({ s }) => s.phase === p.title)) continue
    const nCommits = p.isOpen ? 0 : commits.filter(c => phaseAt(c.at)?.title === p.title).length
    const summary = [
      p.state === 'done' ? T.stepsDone(p.count) : p.state === 'current' ? T.stepOf(Math.min(p.count + 1, p.total), p.total) : T.steps(p.total),
      nCommits ? T.commits(nCommits) : '',
    ].filter(Boolean).join(' · ')
    // An open phase starts with its header; a closed one is one row where it ended.
    const t = p.isOpen ? p.start : p.end
    // At the same moment a finished phase's row comes before the next phase's header.
    const o = !p.isOpen ? -1 : p.start === Infinity ? 1000 + p.pi * 100 - 1 : 0
    list.push({ kind: 'phase', t, o, lane: current, phase: p.title, title: p.title, state: p.state, isOpen: p.isOpen, summary })
  }

  const hasFuture = steps.some(({ s }) => s.status === 'todo')
  const base = lanes.find(l => l.isBase)
  if (hasFuture && base && !lanes[current]?.isBase && v.isPrimary) list.push({ kind: 'merge', t: Infinity, o: 1e9, lane: current, into: base.branch })

  list.sort((a, b) => a.t - b.t || a.o - b.o)
  // Each phase's rows stay together, and phases keep the plan's order: phases that overlap in
  // time (a step finished after the next phase began) must neither cross nor swap places.
  // Rows outside any phase keep their place in time between the blocks.
  const groups = new Map<string, Item[]>()
  const slots: (Item | null)[] = []
  for (const it of list) {
    if (it.phase === undefined) slots.push(it)
    else if (groups.has(it.phase)) groups.get(it.phase)!.push(it)
    else {
      groups.set(it.phase, [it])
      slots.push(null)
    }
  }
  const inPlanOrder = [...groups.keys()].sort((a, b) => trail.phases.indexOf(a) - trail.phases.indexOf(b))
  let next = 0
  return { list: slots.flatMap(s => s ?? groups.get(inPlanOrder[next++]!)!), lanes, current }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s)

const LANE_COLORS = ['#7F77DD', '#1D9E75', '#D85A30', '#D4537E']
export function laneColor(lane: Lane, i: number): string {
  return lane.isBase ? '#888780' : lane.isCurrent ? '#639922' : LANE_COLORS[i % LANE_COLORS.length]!
}

/** At most one short tag after a step's title; the details are in its dialog. `isAlert` draws it in the warning color. */
export function stepTag(v: GraphView, s: Step): { text: string; isAlert: boolean } | undefined {
  const isOpen = s.status !== 'done' && s.status !== 'dropped'
  if (s.status === 'dropped') return { text: T.tagDropped, isAlert: false }
  if (s.addedLate) return { text: T.tagNotInPlan, isAlert: true }
  if (isOpen && s.waitingOn === 'you') return { text: T.tagWaiting, isAlert: true }
  if (isStuck(v.trail, s)) return { text: T.tagStuck(v.trail.turn - (s.startedTurn ?? v.trail.turn)), isAlert: true }
  if (s.status === 'doing') return { text: T.tagHere, isAlert: false }
  return undefined
}

/** The text of a timeline row, drawn natively beside its slice of the lanes. `id` makes it clickable. */
export type RowLabel = { text: string; tail?: string; color?: 'success' | 'suggestion' | 'error' | 'warning'; tailColor?: 'warning'; dim?: boolean; mono?: boolean; strike?: boolean; bold?: boolean; id?: string }

export function rowLabel(v: GraphView, it: Item): RowLabel | undefined {
  if (it.kind === 'commit') {
    if (it.isCompact) return undefined
    const tail = it.tag && !it.label ? ` · ${it.tag} · ${ago(v.now - it.c.at)}` : it.isOwn || it.label ? ` · ${ago(v.now - it.c.at)}` : undefined
    return { text: it.label ?? `${it.c.hash.slice(0, 7)} ${it.c.subject}`, tail, mono: !it.label, color: it.tag ? 'warning' : undefined, dim: !it.isOwn && !it.tag, id: rowKey(it) }
  }
  if (it.kind === 'step') {
    const s = it.s
    const tag = stepTag(v, s)
    return {
      text: `${stepNo(v.trail, s)} ${s.title}`,
      tail: tag && ` · ${tag.text}`,
      tailColor: tag?.isAlert ? 'warning' : undefined,
      color: s.status === 'doing' ? 'suggestion' : s.status === 'blocked' ? 'error' : undefined,
      dim: s.status === 'done' || s.status === 'todo' || s.status === 'dropped',
      strike: s.status === 'dropped',
      bold: s.status === 'doing',
      id: rowKey(it),
    }
  }
  if (it.kind === 'phase') return { text: `${it.isOpen ? '▾' : '▸'} ${v.trail.phases.indexOf(it.title) + 1} ${it.title}`, tail: ` · ${it.summary}`, bold: true, color: it.state === 'current' ? 'suggestion' : undefined, dim: it.state !== 'current', id: rowKey(it) }
  if (it.kind === 'decision') return { text: T.decision(it.text), dim: true }
  if (it.kind === 'stash') return { text: `${it.name} ${it.subject.replace(/^(WIP on|On) [^:]+: /, '')} · ${ago(v.now - it.at)}`, dim: true }
  if (it.kind === 'dirty') return { text: T.filesChanged(it.count) }
  return { text: T.mergeInto(it.into), dim: true }
}

/** One row of the timeline: its band of the lane drawing, in pixels, and its text. */
export type GraphRow = { key: string; top: number; height: number; label?: RowLabel; phase?: string; state?: PhaseState }

const ROW_H = 26
const COMPACT_H = 10

const STYLE = `<style>
  :root { --muted:#6e7781; --line:#d0d7de; --done:#1a7f37; --doing:#0969da; --halo:rgba(9,105,218,.15); --blocked:#cf222e; --bg:#ffffff; --stash:#6e59c9; --decision:#0f7a6a; }
  @media (prefers-color-scheme: dark) { :root { --muted:#8d96a0; --line:#3d444d; --done:#3fb950; --doing:#4493f8; --halo:rgba(68,147,248,.2); --blocked:#f85149; --bg:#0d1117; --stash:#a08cf0; --decision:#3cc7a8; } }
  .rail-todo { stroke: var(--line); stroke-width: 2.5; stroke-dasharray: 4 4; }
  .done-fill { fill: var(--done); } .doing-ring { fill: var(--bg); stroke: var(--doing); stroke-width: 2.5; }
  .doing-fill { fill: var(--doing); } .halo { fill: var(--halo); } .blocked-fill { fill: var(--blocked); }
  .todo-ring { fill: var(--bg); stroke: var(--muted); stroke-width: 2; }
  .diamond-open { fill: var(--bg); stroke: #EF9F27; stroke-width: 2.5; }
  .check { stroke: #fff; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .dirty { fill: none; stroke: var(--doing); stroke-width: 1.5; stroke-dasharray: 2 2; }
  .stash { fill: var(--bg); stroke: var(--stash); stroke-width: 1.5; } .stash-line { stroke: var(--stash); stroke-width: 1; }
  .decision { fill: var(--bg); stroke: var(--decision); stroke-width: 1.5; }
  .legend { font-size: 11px; fill: var(--muted); }
  @keyframes enter { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: none; } }
  .enter { animation: enter .45s ease-out both; }
  @media (prefers-reduced-motion: reduce) { .enter { animation: none; } }
</style>`

const svgDoc = (y: number, w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${y} ${w} ${h}" width="${w}" height="${h}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">${STYLE}${body}</svg>`

/**
 * The timeline, drawn as rows: clicks on a drawing never reach a mod, so each row
 * is its band of one lane drawing (time runs down) beside native, clickable text.
 * Nothing may lie over the text: in the app a layer over a button takes its clicks.
 * The pane draws phase blocks as native boxes around their rows (GraphRow.phase).
 * Light and dark follow the system's color scheme. `seen` holds the row keys drawn
 * last time: rows not in it ease in.
 */
export function graphLanes(v: GraphView, seen?: ReadonlySet<string>): { width: number; legend: { source: string; width: number; height: number }; rows: GraphRow[]; slice: (row: GraphRow) => string } {
  const { list, lanes } = items(v)
  const laneX = (i: number) => 14 + i * 20
  const width = laneX(lanes.length - 1) + 30

  // Legend: one dot and name per lane, wrapping.
  const LW = 420
  const legend: string[] = []
  let lx = 4
  let ly = 14
  lanes.forEach((l, i) => {
    const label = cut(l.branch, 22)
    const w = 16 + label.length * 6.4 + 14
    if (lx + w > LW) {
      lx = 4
      ly += 16
    }
    legend.push(`<g opacity="${l.relevance}"><circle cx="${lx + 5}" cy="${ly - 4}" r="4" fill="${laneColor(l, i)}"/><text x="${lx + 13}" y="${ly}" class="legend">${esc(label)}</text></g>`)
    lx += w
  })

  const rows: GraphRow[] = []
  const ys: number[] = []
  const parts: string[] = []
  const at = new Map<string, { x: number; y: number }>()
  let top = 0
  let nowY = 0
  const isFresh = (key: string) => seen !== undefined && seen.size > 0 && !seen.has(key)
  // A folded phase is one row: its commits take no room and draw no dot (its row counts them).
  const folded = new Set(list.flatMap(it => (it.kind === 'phase' && !it.isOpen ? [it.title] : [])))

  list.forEach((it, k) => {
    const label = rowLabel(v, it)
    const isHidden = it.kind === 'commit' && it.phase !== undefined && folded.has(it.phase)
    const height = isHidden ? 0 : label ? ROW_H : COMPACT_H
    const y = top + height / 2
    ys[k] = y
    const key = rowKey(it)
    rows.push({ key, top, height, label, phase: it.phase, state: it.phase === undefined ? undefined : phaseState(v.trail.steps.filter(s => s.phase === it.phase)) })
    const x = laneX(it.lane)
    const lane = lanes[it.lane]
    const op = lane ? lane.relevance : 1
    const row: string[] = []
    if (it.kind === 'commit') {
      at.set(it.c.hash, { x, y })
      const color = it.tag ? '#BA7517' : laneColor(lanes[it.lane]!, it.lane)
      if (!isHidden) row.push(`<circle cx="${x}" cy="${y}" r="${it.isCompact ? 3 : 4.5}" fill="${color}" opacity="${it.tag ? 1 : op}"/>`)
      nowY = Math.max(nowY, y)
    } else if (it.kind === 'step') {
      const s = it.s
      if (it.t !== Infinity) nowY = Math.max(nowY, y)
      if (s.addedLate && s.status !== 'dropped') {
        const fill = s.status === 'done' ? 'fill="#EF9F27"' : 'class="diamond-open"'
        row.push(`<path d="M${x} ${y - 8} l8 8 l-8 8 l-8 -8 Z" ${fill}/>`)
      } else if (s.status === 'done') {
        row.push(`<circle cx="${x}" cy="${y}" r="7.5" class="done-fill"/><path d="M${x - 3.5} ${y} l2.5 2.6 l4.5 -5" class="check"/>`)
      } else if (s.status === 'doing') {
        row.push(`<circle cx="${x}" cy="${y}" r="12" class="halo"/><circle cx="${x}" cy="${y}" r="7.5" class="doing-ring"/><circle cx="${x}" cy="${y}" r="3" class="doing-fill"/>`)
      } else if (s.status === 'blocked') {
        row.push(`<circle cx="${x}" cy="${y}" r="7.5" class="blocked-fill"/><path d="M${x - 3} ${y - 3} l6 6 M${x + 3} ${y - 3} l-6 6" class="check"/>`)
      } else if (s.status === 'dropped') {
        row.push(`<circle cx="${x}" cy="${y}" r="5" class="todo-ring" opacity="0.5"/>`)
      } else {
        row.push(`<circle cx="${x}" cy="${y}" r="6.5" class="todo-ring"/>`)
      }
    } else if (it.kind === 'decision') {
      nowY = Math.max(nowY, y)
      row.push(`<path d="M${x} ${y - 5} l5 5 l-5 5 l-5 -5 Z" class="decision"/>`)
    } else if (it.kind === 'stash') {
      row.push(`<g opacity="${it.isFaded ? 0.55 : 1}"><line x1="${x}" y1="${y}" x2="${x + 12}" y2="${y}" class="stash-line"/><rect x="${x + 12}" y="${y - 5}" width="10" height="10" rx="2" class="stash"/></g>`)
    } else if (it.kind === 'dirty') {
      nowY = Math.max(nowY, y)
      row.push(`<circle cx="${x}" cy="${y}" r="5" class="dirty"/>`)
    } else if (it.kind === 'phase') {
      // An open phase's header is text only; a folded phase is one node that says how far it got.
      if (!it.isOpen && it.state === 'done') {
        row.push(`<circle cx="${x}" cy="${y}" r="7.5" class="done-fill"/><path d="M${x - 3.5} ${y} l2.5 2.6 l4.5 -5" class="check"/>`)
        nowY = Math.max(nowY, y)
      } else if (!it.isOpen) {
        row.push(it.state === 'current' ? `<circle cx="${x}" cy="${y}" r="7.5" class="doing-ring"/><circle cx="${x}" cy="${y}" r="3" class="doing-fill"/>` : `<circle cx="${x}" cy="${y}" r="6.5" class="todo-ring"/>`)
      }
    } else {
      const bx = laneX(lanes.findIndex(l => l.isBase))
      row.push(`<path d="M${x} ${y - 12} C${x} ${y + 4}, ${bx} ${y - 4}, ${bx} ${y + 12}" class="rail-todo" fill="none"/>`)
    }
    parts.push(isFresh(key) ? `<g class="enter">${row.join('')}</g>` : row.join(''))
    top += height
  })
  const lastY = ys.at(-1) ?? 0

  // Lane lines: each lane runs through its own rows; the current one goes on dashed past "now".
  const lines: string[] = []
  lanes.forEach((l, i) => {
    const mineY = list.map((it, k) => (it.lane === i ? ys[k]! : undefined)).filter((n): n is number => n !== undefined)
    const x = laneX(i)
    const color = laneColor(l, i)
    let y1 = mineY.length ? Math.min(...mineY) : 0
    const y2 = l.isBase ? lastY : mineY.length ? Math.max(...mineY) : 0
    const from = l.forkFrom ? at.get(l.forkFrom) : undefined
    if (from && from.x !== x) {
      lines.push(`<path d="M${from.x} ${from.y} C${from.x} ${from.y + 14}, ${x} ${y1 - 14}, ${x} ${y1}" fill="none" stroke="${color}" stroke-width="2.5" opacity="${l.relevance}"/>`)
    } else if (l.isBase || l.isCurrent) {
      y1 = 0
    }
    const solidEnd = l.isCurrent || l.isBase ? Math.min(Math.max(nowY, y1), y2) : y2
    if (solidEnd > y1) lines.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${solidEnd}" stroke="${color}" stroke-width="2.5" opacity="${l.relevance}"/>`)
    if (y2 > solidEnd) lines.push(`<line x1="${x}" y1="${solidEnd}" x2="${x}" y2="${y2}" class="rail-todo" opacity="${l.relevance}"/>`)
  })
  // Merge commits: a curve from the second parent into the merge.
  for (const c of v.repo.graph?.commits ?? []) {
    const to = at.get(c.hash)
    const from = c.parents[1] ? at.get(c.parents[1]) : undefined
    const p = v.repo.graph!.commits.find(x => x.hash === c.parents[1])?.lane
    const pl = p === undefined ? undefined : lanes[p]
    if (to && from && pl && p !== undefined && from.x !== to.x) lines.push(`<path d="M${from.x} ${from.y} C${from.x} ${from.y + 14}, ${to.x} ${to.y - 14}, ${to.x} ${to.y}" fill="none" stroke="${laneColor(pl, p)}" stroke-width="2" opacity="${pl.relevance}"/>`)
  }

  // shortcut: every row's image carries the whole lane drawing and shows its own band (a viewBox); cut it per row if pages get large.
  const body = lines.join('') + parts.join('')
  const legendH = ly + 6
  return {
    width,
    legend: { source: svgDoc(0, LW, legendH, legend.join('')), width: LW, height: legendH },
    rows,
    slice: row => svgDoc(row.top, width, row.height, body),
  }
}

/** What each shape, color and line of the timeline means, drawn with the timeline's own marks. */
export function legendSvg(): { source: string; width: number; height: number } {
  const W = 440
  const COL = 228
  const ROW = 22
  const parts: string[] = [`<style>.lg { font-size: 12px; fill: #1f2328; } .lh { font-size: 12px; font-weight: 650; fill: var(--muted); } @media (prefers-color-scheme: dark) { .lg { fill: #e6edf3; } }</style>`]
  const label = (x: number, y: number, text: string, cls = 'lg') => parts.push(`<text x="${x}" y="${y + 4}" class="${cls}">${esc(text)}</text>`)
  // One column: a heading, then one row per mark (x, y are the mark's centre).
  const column = (x0: number, y0: number, heading: string, marks: [(x: number, y: number) => string, string][]) => {
    label(x0, y0, heading, 'lh')
    marks.forEach(([draw, text], i) => {
      const y = y0 + (i + 1) * ROW
      parts.push(draw(x0 + 10, y))
      label(x0 + 28, y, text)
    })
    return y0 + (marks.length + 1) * ROW + 10
  }
  const lane = (cls: string) => (x: number, y: number) => `<line x1="${x - 8}" y1="${y}" x2="${x + 8}" y2="${y}" ${cls}/>`
  const block = (cls: string) => (x: number, y: number) => `<rect x="${x - 10}" y="${y - 7}" width="20" height="14" rx="4" class="${cls}"/>`
  const y1 = column(4, 10, T.lgSteps, [
    [(x, y) => `<circle cx="${x}" cy="${y}" r="7" class="done-fill"/><path d="M${x - 3.5} ${y} l2.5 2.6 l4.5 -5" class="check"/>`, T.lgDone],
    [(x, y) => `<circle cx="${x}" cy="${y}" r="10" class="halo"/><circle cx="${x}" cy="${y}" r="6.5" class="doing-ring"/><circle cx="${x}" cy="${y}" r="2.5" class="doing-fill"/>`, T.lgDoing],
    [(x, y) => `<circle cx="${x}" cy="${y}" r="6" class="todo-ring"/>`, T.lgTodo],
    [(x, y) => `<circle cx="${x}" cy="${y}" r="7" class="blocked-fill"/><path d="M${x - 3} ${y - 3} l6 6 M${x + 3} ${y - 3} l-6 6" class="check"/>`, T.lgBlocked],
    [(x, y) => `<circle cx="${x}" cy="${y}" r="5" class="todo-ring" opacity="0.5"/>`, T.lgDropped],
    [(x, y) => `<path d="M${x} ${y - 7} l7 7 l-7 7 l-7 -7 Z" class="diamond-open"/>`, T.lgLate],
  ])
  column(4, y1, T.lgLanes, [
    [lane('stroke="#639922" stroke-width="2.5"'), T.lgCurrent],
    [lane('stroke="#888780" stroke-width="2.5"'), T.lgBase],
    [lane('class="rail-todo"'), T.lgToCome],
  ])
  const y2 = column(COL, 10, T.lgMarks, [
    [(x, y) => `<circle cx="${x}" cy="${y}" r="4.5" fill="#639922"/>`, T.lgCommit],
    [(x, y) => `<circle cx="${x}" cy="${y}" r="4.5" fill="#BA7517"/>`, T.lgCommitElsewhere],
    [(x, y) => `<path d="M${x} ${y - 5} l5 5 l-5 5 l-5 -5 Z" class="decision"/>`, T.lgDecision],
    [(x, y) => `<line x1="${x - 10}" y1="${y}" x2="${x}" y2="${y}" class="stash-line"/><rect x="${x}" y="${y - 5}" width="10" height="10" rx="2" class="stash"/>`, T.lgStash],
    [(x, y) => `<circle cx="${x}" cy="${y}" r="5" class="dirty"/>`, T.lgDirty],
    [(x, y) => `<path d="M${x + 6} ${y - 9} C${x + 6} ${y + 2}, ${x - 6} ${y - 2}, ${x - 6} ${y + 9}" class="rail-todo" fill="none"/>`, T.lgMerge],
  ])
  const height = column(COL, y2, T.lgBlocks, [
    [block('lg-current'), T.lgPhaseCurrent],
    [block('lg-done'), T.lgPhaseDone],
    [block('lg-future'), T.lgPhaseFuture],
  ])
  parts.push(`<style>.lg-current { fill: rgba(68,147,248,.12); stroke: var(--doing); } .lg-done { fill: none; stroke: var(--done); } .lg-future { fill: none; stroke: var(--muted); opacity: .7; }</style>`)
  return { source: svgDoc(0, W, height, parts.join('')), width: W, height }
}

/** A row's identity across redraws: what "new" is measured against, and what a click opens. */
export function rowKey(it: Item): string {
  if (it.kind === 'step') return `step:${it.s.title}`
  if (it.kind === 'phase') return `phase:${it.title}`
  if (it.kind === 'commit') return `commit:${it.c.hash}`
  if (it.kind === 'decision') return `decision:${it.t}:${it.text}`
  if (it.kind === 'stash') return `stash:${it.subject}:${it.at}`
  return it.kind
}

/** A step's status as one character, for the terminal. */
export function stepGlyph(s: Step): string {
  return s.addedLate && s.status !== 'dropped' ? '◆' : { done: '✓', doing: '◉', blocked: '✖', todo: '○', dropped: '⊘' }[s.status]
}

export type TextLine = { text: string; color?: RowLabel['color']; dim?: boolean; id?: string }

/** The terminal has no Svg: the same rows, one per line, indented by lane. */
export function graphText(v: GraphView): TextLine[] {
  const { list, lanes } = items(v)
  const out: TextLine[] = [{ text: lanes.map(l => `${l.isCurrent ? '●' : '○'} ${l.branch}`).join('   '), dim: true }]
  for (const it of list) {
    const l = rowLabel(v, it)
    if (!l) continue
    const glyph = it.kind === 'step' ? stepGlyph(it.s) : { commit: '*', decision: '◇', stash: '▫', dirty: '◌', merge: '╰', phase: '' }[it.kind]
    const pad = it.kind === 'phase' || it.kind === 'merge' ? '' : '│ '.repeat(it.lane)
    out.push({ text: `${pad}${glyph ? `${glyph} ` : ''}${l.text}${l.tail ?? ''}`, color: l.color ?? l.tailColor, dim: l.dim, id: l.id })
  }
  return out
}
