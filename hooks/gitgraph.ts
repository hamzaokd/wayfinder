// Reads git: a repo's live state and the branch graph around this session's work.
import type { EngineInterface } from 'claude-code'

import type { GraphCommit, Lane, RepoGraph, RepoLive, Stash } from '../types'
import { normPath, repoName } from './lib'

type $ = EngineInterface

const RECENT_MS = 7 * 86_400_000
const MAX_OTHER_LANES = 4
// Up to 6 lanes: 25 each made 130-row panes the desktop app left blank.
const MAX_PER_LANE = 10
// A branch shown only for context (another session's, one editing the same files, a recent one).
const SIDE_KEEP = 4
const BASE_KEEP = 5

// Answers that only change when a tip moves: keyed by the hashes involved.
const cache = new Map<string, string | undefined>()

// The mod runs git on its own every few seconds, in repos it did not choose. A repo's own config
// must not make that run a program (core.fsmonitor), and a read must not take the index lock.
// Hooks are already off for $.process.run. Filters (gitattributes clean/smudge) can still run on
// `status`, as they do when Claude or you run it there.
export const GIT = ['git', '-c', 'core.fsmonitor=false', '--no-optional-locks'] as const

export async function git($: $, cwd: string, args: string[], isRaw = false): Promise<string | undefined> {
  const r = await $.process.run([...GIT, ...args], { cwd, timeoutMs: 10_000 })
  // A non-zero exit is an answer here ("not a repo", "no upstream"), not a failure.
  if (r.exitCode !== 0) return undefined
  // Porcelain lines start with a space that trimming would eat.
  return isRaw ? r.stdout.replace(/\n+$/, '') : r.stdout.trim()
}

async function gitCached($: $, cwd: string, key: string, args: string[]): Promise<string | undefined> {
  const k = `${cwd}\n${key}`
  if (cache.has(k)) return cache.get(k)
  const out = await git($, cwd, args)
  if (cache.size > 500) cache.clear()
  cache.set(k, out)
  return out
}

export async function isAncestor($: $, cwd: string, old: string, head: string): Promise<boolean> {
  const r = await $.process.run([...GIT, 'merge-base', '--is-ancestor', old, head], { cwd, timeoutMs: 10_000 })
  return r.exitCode === 0
}

export async function repoRoot($: $, dir: string): Promise<string | undefined> {
  // rejects when the folder no longer exists: then it isn't a repo
  const top = await git($, dir, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  return top ? normPath(top) : undefined
}

export async function snapshot($: $, root: string): Promise<RepoLive | undefined> {
  if (!(await repoRoot($, root))) return undefined
  const [branch, head, status, updown, originHead] = await Promise.all([
    git($, root, ['symbolic-ref', '--short', 'HEAD']),
    git($, root, ['rev-parse', 'HEAD']),
    git($, root, ['status', '--porcelain'], true),
    git($, root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    git($, root, ['rev-parse', '--abbrev-ref', 'origin/HEAD']),
  ])
  if (status === undefined) throw new Error(`git status failed in ${root}`)
  const base =
    originHead ??
    ((await git($, root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'])) !== undefined ? 'main'
      : (await git($, root, ['rev-parse', '--verify', '--quiet', 'refs/heads/master'])) !== undefined ? 'master'
      : undefined)
  const name = branch ?? 'detached'
  const isOnBase = base === name || base === `origin/${name}`
  const counts = head && base && !isOnBase ? await git($, root, ['rev-list', '--left-right', '--count', `${base}...HEAD`]) : undefined
  const [behindBase, sinceBase] = counts ? counts.split(/\s+/).map(Number) : []
  const [behind, ahead] = updown ? updown.split(/\s+/).map(Number) : []
  const dirtyFiles = status === '' ? [] : status.split('\n').map(l => l.slice(3).replace(/^.* -> /, ''))
  return {
    root,
    name: repoName(root),
    branch: name,
    head: head ?? '',
    dirty: dirtyFiles.length,
    dirtyFiles,
    ahead,
    behind,
    base,
    sinceBase,
    behindBase,
  }
}

export type GraphCtx = {
  now: number
  /** Branches this session has been on in this repo. */
  sessionBranches: readonly string[]
  /** Branches other sessions are on in this repo, and that session's goal. */
  otherBranches: ReadonlyMap<string, string>
}

type Ref = { branch: string; tip: string; at: number }

/**
 * The branches around this work, faded by fixed rules:
 * 1 = the base, the current branch and branches this session was on;
 * 0.55 = another session's branch, or one that edits the same files as this work;
 * 0.25 = other branches with commits in the last 7 days; the rest are only counted.
 */
export async function repoGraph($: $, live: RepoLive, ctx: GraphCtx): Promise<RepoGraph> {
  const root = live.root
  const refsOut = (await git($, root, ['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)', 'refs/heads'])) ?? ''
  const refs: Ref[] = refsOut.split('\n').filter(Boolean).map(l => {
    const [branch = '', tip = '', at = '0'] = l.split('\t')
    return { branch, tip, at: Number(at) * 1000 }
  })
  const baseName = live.base
  const baseTip = baseName ? await git($, root, ['rev-parse', baseName]) : undefined
  const baseShort = baseName?.replace(/^origin\//, '')
  const lanes: Lane[] = []
  if (baseName && baseTip) lanes.push({ branch: baseName, relevance: 1, why: 'base', isBase: true, isCurrent: live.branch === baseShort, tip: baseTip })
  if (live.head && live.branch !== baseShort) lanes.push({ branch: live.branch, relevance: 1, why: 'current', isCurrent: true, tip: live.head })

  // Files this work touches: the branch's diff from the base, plus uncommitted ones.
  const workFiles = new Set(live.dirtyFiles)
  if (baseTip && live.head && live.branch !== baseShort) {
    const diff = await gitCached($, root, `diff ${baseTip} ${live.head}`, ['diff', '--name-only', `${baseTip}...${live.head}`])
    for (const f of diff?.split('\n').filter(Boolean) ?? []) workFiles.add(f)
  }

  let hidden = 0
  const others: Lane[] = []
  for (const ref of refs) {
    if (ref.branch === live.branch || ref.branch === baseShort || ref.branch === baseName) continue
    if (ctx.sessionBranches.includes(ref.branch)) {
      others.push({ branch: ref.branch, relevance: 1, why: 'this session', tip: ref.tip })
      continue
    }
    const goal = ctx.otherBranches.get(ref.branch)
    if (goal !== undefined) {
      others.push({ branch: ref.branch, relevance: 0.55, why: `other session: ${goal}`, tip: ref.tip })
      continue
    }
    if (ctx.now - ref.at > RECENT_MS) {
      hidden += 1
      continue
    }
    let overlap: string | undefined
    if (baseTip && workFiles.size > 0) {
      const diff = await gitCached($, root, `diff ${baseTip} ${ref.tip}`, ['diff', '--name-only', `${baseTip}...${ref.tip}`])
      overlap = diff?.split('\n').find(f => workFiles.has(f))
    }
    others.push(overlap ? { branch: ref.branch, relevance: 0.55, why: `also edits ${overlap.split('/').at(-1)}`, tip: ref.tip } : { branch: ref.branch, relevance: 0.25, why: 'recent', tip: ref.tip })
  }
  others.sort((a, b) => b.relevance - a.relevance)
  hidden += Math.max(0, others.length - MAX_OTHER_LANES)
  lanes.push(...others.slice(0, MAX_OTHER_LANES))
  if (lanes.length === 0) return { lanes, commits: [], stashes: [], hidden, skipped: 0 }

  // History from where the first of these branches split off the base, to every tip.
  const tips = lanes.map(l => l.tip)
  const since = tips.length > 1 ? await gitCached($, root, `octopus ${tips.join(' ')}`, ['merge-base', '--octopus', ...tips]) : undefined
  const fmt = '--format=%H%x09%P%x09%ct%x09%s'
  const logOut = (await git($, root, ['log', '--date-order', '-n', '150', fmt, ...tips, ...(since ? ['--not', `${since}^@`] : [])])) ?? ''
  const all = logOut.split('\n').filter(Boolean).map(l => {
    const [hash = '', parents = '', at = '0', ...subject] = l.split('\t')
    return { hash, parents: parents.split(' ').filter(Boolean), at: Number(at) * 1000, subject: subject.join('\t'), lane: -1 }
  })
  claimLanes(lanes, all)
  const refsOf = dropEmptyLanes(lanes, all)

  // Keep the graph short: the newest commits of each lane, plus every fork point and named commit.
  const forkPoints = new Set([...lanes.map(l => l.forkFrom).filter(Boolean), ...refsOf.keys()])
  const kept: GraphCommit[] = []
  let skipped = 0
  lanes.forEach((lane, i) => {
    const mine = all.filter(c => c.lane === i)
    const limit = lane.isBase ? BASE_KEEP : lane.relevance < 1 ? SIDE_KEEP : MAX_PER_LANE
    mine.forEach((c, k) => {
      if (k < limit || forkPoints.has(c.hash)) kept.push(refsOf.has(c.hash) ? { ...c, refs: refsOf.get(c.hash) } : c)
      else skipped += 1
    })
  })

  // Oldest first in git's own order (--date-order: never a parent after its child), not by date: a
  // rebased commit's date can be older than its parent's, which drew lines running back up.
  const order = new Map(all.map((c, k) => [c.hash, k]))

  const stashOut = (await git($, root, ['stash', 'list', '--format=%gd%x09%s%x09%ct%x09%P'])) ?? ''
  const stashes: Stash[] = stashOut.split('\n').filter(Boolean).map(l => {
    const [name = '', subject = '', at = '0', parents = ''] = l.split('\t')
    return { name, subject, at: Number(at) * 1000, parent: parents.split(' ')[0] ?? '', branch: /^(?:WIP on|On) ([^:]+):/.exec(subject)?.[1] }
  })

  return { lanes, commits: kept.sort((a, b) => order.get(b.hash)! - order.get(a.hash)!), stashes: recentStashes(stashes, lanes, kept, ctx.now), hidden, skipped }
}

/**
 * Each lane claims its first-parent line until it meets one already claimed (sets `c.lane` and the
 * lane's `forkFrom`). The current branch claims first: it is this work. Then a branch claims before
 * every branch whose tip it contains: a branch that is only behind another, as master fast-forwarded
 * to a commit of develop, has no commit of its own and must not look like the other forked from it.
 */
export function claimLanes(lanes: Lane[], commits: GraphCommit[]): void {
  const byHash = new Map(commits.map(c => [c.hash, c]))
  const tips = lanes.map(lane => {
    const seen = new Set<string>()
    const todo = [lane.tip]
    for (let h = todo.pop(); h !== undefined; h = todo.pop()) {
      if (seen.has(h)) continue
      seen.add(h)
      todo.push(...(byHash.get(h)?.parents ?? []))
    }
    // How many other lanes' tips this one holds: more first is an order where a holder claims before what it holds.
    return lanes.filter(o => o !== lane && seen.has(o.tip)).length
  })
  const order = lanes.map((_, i) => i).sort((a, b) => Number(!!lanes[b]!.isCurrent) - Number(!!lanes[a]!.isCurrent) || tips[b]! - tips[a]! || a - b)
  for (const i of order) {
    const lane = lanes[i]!
    let c = byHash.get(lane.tip)
    while (c && c.lane === -1) {
      c.lane = i
      c = c.parents[0] ? byHash.get(c.parents[0]) : undefined
    }
    if (c) lane.forkFrom = c.hash
  }
}

/**
 * A branch whose tip already sits on another lane (the base too) has no commit of its own: it gets no
 * lane (an empty one drew a line from nowhere) and its name goes on that commit. Removes those lanes
 * from `lanes`, renumbers the commits' lanes, and returns tip hash -> branch names.
 */
export function dropEmptyLanes(lanes: Lane[], commits: GraphCommit[]): Map<string, string[]> {
  const refsOf = new Map<string, string[]>()
  const drawn = lanes.filter((lane, i) => {
    const isEmpty = !lane.isCurrent && !commits.some(c => c.lane === i)
    if (isEmpty) refsOf.set(lane.tip, [...(refsOf.get(lane.tip) ?? []), lane.branch])
    return !isEmpty
  })
  const newIndex = new Map(drawn.map((l, k) => [lanes.indexOf(l), k]))
  for (const c of commits) if (c.lane !== -1) c.lane = newIndex.get(c.lane)!
  lanes.splice(0, lanes.length, ...drawn)
  return refsOf
}

/** Stashes from the last 7 days on a branch the graph draws: 101 old ones made a 130-row pane the app left blank. */
export function recentStashes(stashes: readonly Stash[], lanes: readonly Lane[], kept: readonly GraphCommit[], now: number): Stash[] {
  const branches = new Set(lanes.map(l => l.branch.replace(/^origin\//, '')))
  const hashes = new Set(kept.map(c => c.hash))
  return stashes.filter(s => now - s.at <= RECENT_MS && ((s.branch !== undefined && branches.has(s.branch)) || hashes.has(s.parent)))
}
