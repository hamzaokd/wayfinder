// The branch graph with the session's plan on it: lanes are branches, time runs down,
// phases are blocks, steps sit on the branch where they ran, todo steps continue dashed.
// One SVG, drawn as a plain picture: the step list under it takes the clicks.
import type { GraphCommit, Lane, RepoLive, Step, Trail } from '../types'
import { ago, isStuck } from './lib'

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

type PhaseState = 'done' | 'current' | 'future'

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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

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
    const starts = own.filter(s => s.status !== 'dropped' || s.startedAt !== undefined).map(s => s.startedAt ?? s.doneAt).filter((x): x is number => x !== undefined)
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
    const tag = owner ? `from "${owner}"` : outside.has(c.hash) ? 'outside' : undefined
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
    list.push({ kind: 'stash', t: st.at, o: 3, lane: onLane ?? laneOfBranch(st.branch), name: st.name, subject: st.subject, at: st.at, isFaded: st.branch !== repo.branch })
  }

  if (repo.dirty > 0) list.push({ kind: 'dirty', t: now, o: 4, lane: current, count: repo.dirty, phase: phaseAt(now)?.title })

  for (const p of phases) {
    if (!steps.some(({ s }) => s.phase === p.title)) continue
    const nCommits = p.isOpen ? 0 : commits.filter(c => phaseAt(c.at)?.title === p.title).length
    const summary = [
      p.state === 'done' ? `${plural(p.count, 'step')} done` : p.state === 'current' ? `step ${Math.min(p.count + 1, p.total)} of ${p.total}` : plural(p.total, 'step'),
      nCommits ? plural(nCommits, 'commit') : '',
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
  return { list, lanes, current }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s)

const LANE_COLORS = ['#7F77DD', '#1D9E75', '#D85A30', '#D4537E']
export function laneColor(lane: Lane, i: number): string {
  return lane.isBase ? '#888780' : lane.isCurrent ? '#639922' : LANE_COLORS[i % LANE_COLORS.length]!
}

/** The one line under a step: what matters most, nothing else. The rest is in the hover. */
export function stepLine(v: GraphView, s: Step): { text: string; cls: string } | undefined {
  const isOpen = s.status !== 'done' && s.status !== 'dropped'
  if (s.status === 'dropped') return { text: `Dropped · ${s.reason ?? 'no reason given'}`, cls: 'sub drift' }
  if (s.addedLate) return { text: `Not in plan · ${s.reason ?? 'no reason given'}`, cls: 'sub drift' }
  if (s.outOfOrder) return { text: 'Done before earlier steps', cls: 'sub drift' }
  if (isStuck(v.trail, s)) return { text: `Stuck for ${v.trail.turn - (s.startedTurn ?? v.trail.turn)} turns`, cls: 'sub drift' }
  if (isOpen && s.waitingOn === 'you') return { text: `waiting on you${s.waitingFor ? `: ${s.waitingFor}` : ''}`, cls: 'sub waiting' }
  if (s.note) return { text: s.note, cls: 'sub' }
  return undefined
}

/**
 * The graph as one SVG. Light and dark follow the system's color scheme.
 * `seen` holds the row ids drawn last time: rows not in it animate in, and the
 * rows below them slide down from where they were instead of jumping.
 */
export function graphSvg(v: GraphView, seen?: ReadonlySet<string>): { source: string; width: number; height: number; ids: string[] } {
  const { list, lanes } = items(v)
  const laneX = (i: number) => 18 + i * 24
  const textX = Math.max(70, laneX(lanes.length - 1) + 28)
  const W = textX + 380
  const chars = (px: number) => Math.floor((W - textX - 8) / px)

  // Legend: one dot and name per lane, wrapping.
  const legend: string[] = []
  let lx = 8
  let ly = 16
  lanes.forEach((l, i) => {
    const label = cut(l.branch, 22)
    const w = 16 + label.length * 6.4 + 14
    if (lx + w > W) {
      lx = 8
      ly += 16
    }
    legend.push(`<g opacity="${l.relevance}"><circle cx="${lx + 5}" cy="${ly - 4}" r="4" fill="${laneColor(l, i)}"/><text x="${lx + 13}" y="${ly}" class="legend">${esc(label)}</text></g>`)
    lx += w
  })

  const ys: number[] = []
  const parts: string[] = []
  const blocks: string[] = []
  const at = new Map<string, { x: number; y: number }>()
  let y = ly + 14
  if (v.repo.graph?.skipped) {
    y += 8
    parts.push(`<text x="${textX}" y="${y + 4}" class="sub">+${v.repo.graph.skipped} older commits not shown</text>`)
    y += 10
  }
  const phaseSpan = new Map<string, { y1: number; y2: number; state: PhaseState }>()
  let nowY = y
  let lastY = y
  const rowSvg: string[] = []
  const rowTop: number[] = []
  let row: string[] = []

  list.forEach((it, k) => {
    row = []
    rowTop[k] = y
    const gap = k === 0 ? 8 : it.kind === 'commit' && it.isCompact ? 9 : it.kind === 'phase' ? 28 : 22
    y += gap
    const x = laneX(it.lane)
    const lane = lanes[it.lane]
    const op = lane ? lane.relevance : 1
    if (it.kind === 'commit') {
      at.set(it.c.hash, { x, y })
      const color = it.tag ? '#BA7517' : laneColor(lanes[it.lane]!, it.lane)
      row.push(`<circle cx="${x}" cy="${y}" r="${it.isCompact ? 3 : 4.5}" fill="${color}" opacity="${it.tag ? 1 : op}"/>`)
      if (!it.isCompact) {
        const text = it.label ?? `${it.c.hash.slice(0, 7)} ${it.c.subject}`
        const tail = it.tag && !it.label ? ` · ${it.tag} · ${ago(v.now - it.c.at)}` : it.isOwn || it.label ? ` · ${ago(v.now - it.c.at)}` : ''
        const cls = it.tag ? 'ev warn' : it.isOwn ? 'ev' : 'ev muted'
        row.push(`<text x="${textX}" y="${y + 4}" class="${cls}" opacity="${it.label ? op : 1}">${esc(cut(text, chars(7.2) - tail.length))}<tspan class="muted">${esc(tail)}</tspan></text>`)
      }
      nowY = Math.max(nowY, y)
    } else if (it.kind === 'step') {
      const s = it.s
      const isFuture = it.t === Infinity
      if (!isFuture) nowY = Math.max(nowY, y)
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
      const here = s.status === 'doing' ? ' · you are here' : ''
      row.push(`<text x="${textX}" y="${y + 5}" class="step ${s.status}">${esc(cut(`${it.index + 1}. ${s.title}`, chars(7.6) - here.length))}${here}</text>`)
      const line = stepLine(v, s)
      if (line) {
        y += 16
        row.push(`<text x="${textX}" y="${y + 4}" class="${line.cls}">${esc(cut(line.text, chars(6.6)))}</text>`)
      }
    } else if (it.kind === 'decision') {
      nowY = Math.max(nowY, y)
      row.push(`<path d="M${x} ${y - 5} l5 5 l-5 5 l-5 -5 Z" class="decision"/>`)
      row.push(`<text x="${textX}" y="${y + 4}" class="sub decision-text">${esc(cut(`Decision: ${it.text}`, chars(6.6)))}</text>`)
    } else if (it.kind === 'stash') {
      const o = it.isFaded ? 0.55 : 1
      row.push(`<g opacity="${o}"><line x1="${x}" y1="${y}" x2="${x + 12}" y2="${y}" class="stash-line"/><rect x="${x + 12}" y="${y - 5}" width="10" height="10" rx="2" class="stash"/></g>`)
      const text = `${it.name} ${it.subject.replace(/^(WIP on|On) [^:]+: /, '')} · ${ago(v.now - it.at)}`
      row.push(`<text x="${textX}" y="${y + 4}" class="sub stash-text" opacity="${o}">${esc(cut(text, chars(6.6)))}</text>`)
    } else if (it.kind === 'dirty') {
      nowY = Math.max(nowY, y)
      row.push(`<circle cx="${x}" cy="${y}" r="5" class="dirty"/>`)
      row.push(`<text x="${textX}" y="${y + 4}" class="sub">${plural(it.count, 'file')} changed, not committed</text>`)
    } else if (it.kind === 'phase') {
      if (it.isOpen) {
        phaseSpan.set(it.title, { y1: y - 12, y2: y + 6, state: it.state })
        row.push(`<text x="${textX}" y="${y + 5}" class="phase ${it.state}">▾ ${esc(cut(it.title, 30))}<tspan class="phase-sub"> · ${esc(it.summary)}</tspan></text>`)
      } else {
        row.push(`<circle cx="${x}" cy="${y}" r="7.5" class="done-fill"/><path d="M${x - 3.5} ${y} l2.5 2.6 l4.5 -5" class="check"/>`)
        blocks.push(`<rect x="${laneX(0) - 12}" y="${y - 14}" width="${W - laneX(0) + 8}" height="28" rx="7" class="block-done"/>`)
        row.push(`<text x="${textX}" y="${y + 5}" class="phase done">▸ ${esc(cut(it.title, 30))}<tspan class="phase-sub"> · ${esc(it.summary)}</tspan></text>`)
        nowY = Math.max(nowY, y)
      }
    } else {
      const bx = laneX(lanes.findIndex(l => l.isBase))
      row.push(`<path d="M${x} ${y - 12} C${x} ${y + 4}, ${bx} ${y - 4}, ${bx} ${y + 12}" class="rail-todo" fill="none"/>`)
      row.push(`<text x="${textX}" y="${y + 8}" class="sub">Merge into ${esc(it.into)} (planned)</text>`)
      y += 12
    }
    if (it.phase && phaseSpan.has(it.phase)) phaseSpan.get(it.phase)!.y2 = y + 10
    ys[k] = y
    lastY = y
    rowSvg[k] = row.join('')
  })

  // New rows ease in; every row below them starts where it was and slides down.
  const ids = list.map(rowKey)
  const hasSeen = seen !== undefined && seen.size > 0
  let added = 0
  const rowsOut = rowSvg.map((svg, k) => {
    if (hasSeen && !seen.has(ids[k]!)) {
      added += ys[k]! - rowTop[k]!
      return `<g class="enter">${svg}</g>`
    }
    return added ? `<g class="slide" style="--dy:-${added}px">${svg}</g>` : svg
  })

  for (const span of phaseSpan.values()) blocks.push(`<rect x="${laneX(0) - 12}" y="${span.y1}" width="${W - laneX(0) + 8}" height="${span.y2 - span.y1}" rx="8" class="block-${span.state}"/>`)

  // Lane lines: each lane runs through its own rows; the current one goes on dashed past "now".
  const lines: string[] = []
  const top = ly + 14
  lanes.forEach((l, i) => {
    const mineY = list.map((it, k) => (it.lane === i ? ys[k]! : undefined)).filter((n): n is number => n !== undefined)
    const x = laneX(i)
    const color = laneColor(l, i)
    let y1 = mineY.length ? Math.min(...mineY) : top
    const y2 = l.isBase ? lastY : mineY.length ? Math.max(...mineY) : top
    const from = l.forkFrom ? at.get(l.forkFrom) : undefined
    if (from && from.x !== x) {
      lines.push(`<path d="M${from.x} ${from.y} C${from.x} ${from.y + 14}, ${x} ${y1 - 14}, ${x} ${y1}" fill="none" stroke="${color}" stroke-width="2.5" opacity="${l.relevance}"/>`)
    } else if (l.isBase || l.isCurrent) {
      y1 = Math.min(y1, top)
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

  let height = lastY + 20
  if (v.repo.graph?.hidden) {
    parts.push(`<text x="8" y="${height + 2}" class="sub">+${v.repo.graph.hidden} other branch${v.repo.graph.hidden === 1 ? '' : 'es'} hidden (no recent commits)</text>`)
    height += 16
  }

  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">
<style>
  :root { --text:#1f2328; --muted:#6e7781; --line:#d0d7de; --done:#1a7f37; --doing:#0969da; --halo:rgba(9,105,218,.15); --blocked:#cf222e; --warn:#bc4c00; --bg:#ffffff; --tint:rgba(9,105,218,.05); --stash:#6e59c9; --decision:#0f7a6a; }
  @media (prefers-color-scheme: dark) { :root { --text:#e6edf3; --muted:#8d96a0; --line:#3d444d; --done:#3fb950; --doing:#4493f8; --halo:rgba(68,147,248,.2); --blocked:#f85149; --warn:#db6d28; --bg:#0d1117; --tint:rgba(68,147,248,.07); --stash:#a08cf0; --decision:#3cc7a8; } }
  .rail-todo { stroke: var(--line); stroke-width: 2.5; stroke-dasharray: 4 4; }
  .done-fill { fill: var(--done); } .doing-ring { fill: var(--bg); stroke: var(--doing); stroke-width: 2.5; }
  .doing-fill { fill: var(--doing); } .halo { fill: var(--halo); } .blocked-fill { fill: var(--blocked); }
  .todo-ring { fill: var(--bg); stroke: var(--muted); stroke-width: 2; }
  .diamond-open { fill: var(--bg); stroke: #EF9F27; stroke-width: 2.5; }
  .check { stroke: #fff; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .dirty { fill: none; stroke: var(--doing); stroke-width: 1.5; stroke-dasharray: 2 2; }
  .stash { fill: var(--bg); stroke: var(--stash); stroke-width: 1.5; } .stash-line { stroke: var(--stash); stroke-width: 1; } .stash-text { fill: var(--stash); }
  .decision { fill: var(--bg); stroke: var(--decision); stroke-width: 1.5; } .decision-text { fill: var(--decision); }
  .block-current { fill: var(--tint); stroke: var(--doing); stroke-width: .6; } .block-done { fill: none; stroke: var(--done); stroke-width: .6; }
  .block-future { fill: none; stroke: var(--muted); stroke-width: .6; stroke-dasharray: 4 4; }
  text { fill: var(--text); } .legend { font-size: 11px; fill: var(--muted); }
  .step { font-size: 14px; } .doing { font-weight: 650; fill: var(--doing); } .done, .todo { fill: var(--muted); }
  .blocked { fill: var(--blocked); font-weight: 600; } .dropped { fill: var(--muted); text-decoration: line-through; opacity: .7; }
  .phase { font-size: 13px; font-weight: 650; } .phase.current { fill: var(--doing); } .phase.done, .phase.future { fill: var(--muted); }
  .phase-sub { font-weight: 400; fill: var(--muted); }
  .sub { font-size: 12px; fill: var(--muted); } .waiting { fill: var(--warn); font-weight: 600; } .drift { fill: var(--warn); }
  .ev { font-family: ui-monospace, Consolas, monospace; font-size: 12px; } .warn { fill: var(--warn); }
  .muted { fill: var(--muted); }
  @keyframes enter { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
  @keyframes slide { from { transform: translateY(var(--dy)); } to { transform: none; } }
  .enter { animation: enter .45s ease-out both; } .slide { animation: slide .4s ease-out both; }
  @media (prefers-reduced-motion: reduce) { .enter, .slide { animation: none; } }
</style>
${blocks.join('')}${lines.join('')}${rowsOut.join('')}${legend.join('')}${parts.join('')}
</svg>`
  return { source, width: W, height, ids }
}

/** A row's identity across redraws: what "new" is measured against. */
export function rowKey(it: Item): string {
  if (it.kind === 'step') return `step:${it.s.title}`
  if (it.kind === 'phase') return `phase:${it.title}`
  if (it.kind === 'commit') return `commit:${it.c.hash}`
  if (it.kind === 'decision') return `decision:${it.t}:${it.text}`
  if (it.kind === 'stash') return `stash:${it.subject}:${it.at}`
  return it.kind
}

/** A step's status as one character, for the terminal graph and the step list. */
export function stepGlyph(s: Step): string {
  return s.addedLate && s.status !== 'dropped' ? '◆' : { done: '✓', doing: '◉', blocked: '✖', todo: '○', dropped: '⊘' }[s.status]
}

export type TextLine = { text: string; color?: 'success' | 'suggestion' | 'error' | 'warning'; dim?: boolean; id?: string }

/** The terminal has no Svg: the same rows, one per line, indented by lane. */
export function graphText(v: GraphView): TextLine[] {
  const { list, lanes } = items(v)
  const out: TextLine[] = [{ text: lanes.map(l => `${l.isCurrent ? '●' : '○'} ${l.branch}`).join('   '), dim: true }]
  const pad = (lane: number) => '│ '.repeat(lane)
  for (const it of list) {
    if (it.kind === 'phase') out.push({ text: `${it.isOpen ? '▾' : '▸'} ${it.title} · ${it.summary}`, color: it.state === 'current' ? 'suggestion' : undefined, dim: it.state !== 'current', id: rowKey(it) })
    else if (it.kind === 'commit' && !it.isCompact) out.push({ text: `${pad(it.lane)}* ${it.label ?? `${it.c.hash.slice(0, 7)} ${it.c.subject}`}${it.tag ? ` · ${it.tag}` : ''}`, color: it.tag ? 'warning' : undefined, dim: !it.isOwn && !it.tag, id: rowKey(it) })
    else if (it.kind === 'step') {
      const s = it.s
      out.push({ text: `${pad(it.lane)}${stepGlyph(s)} ${it.index + 1}. ${s.title}${s.status === 'doing' ? ' · you are here' : ''}`, color: s.status === 'done' ? 'success' : s.status === 'doing' ? 'suggestion' : s.status === 'blocked' ? 'error' : undefined, dim: s.status === 'todo' || s.status === 'dropped', id: rowKey(it) })
      const line = stepLine(v, s)
      if (line) out.push({ text: `${pad(it.lane)}    ${line.text}`, color: line.cls.includes('drift') || line.cls.includes('waiting') ? 'warning' : undefined, dim: line.cls === 'sub' })
    } else if (it.kind === 'decision') out.push({ text: `${pad(it.lane)}◇ Decision: ${it.text}`, dim: true })
    else if (it.kind === 'stash') out.push({ text: `${pad(it.lane)}▫ ${it.name} ${it.subject}`, dim: it.isFaded })
    else if (it.kind === 'dirty') out.push({ text: `${pad(it.lane)}◌ ${it.count} files changed, not committed` })
    else if (it.kind === 'merge') out.push({ text: `╰ merge into ${it.into} (planned)`, dim: true })
  }
  return out
}
