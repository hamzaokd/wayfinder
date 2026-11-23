export type StepStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'dropped'

export type Step = {
  title: string
  phase: string
  status: StepStatus
  /** What came out of the step: "yes, via role X", "p95 120ms". */
  note?: string
  waitingOn?: 'you' | 'claude'
  /** What exactly it waits for: "run the benchmark on staging". */
  waitingFor?: string
  /** What the step is for, in a sentence: shown when the step is clicked. */
  detail?: string
  /** Added after the first plan: off plan. */
  addedLate?: boolean
  /** Why it was added or dropped. */
  reason?: string
  outOfOrder?: boolean
  startedAt?: number
  startedTurn?: number
  /** When it was finished, or dropped. */
  doneAt?: number
  /** Repo root and branch where it ran. */
  repo?: string
  branch?: string
  /** Files Claude edited while this step was current. */
  files: string[]
}

export type Decision = { at: number; text: string; why?: string; step?: string; repo?: string; branch?: string }

export type TrailEvent = {
  at: number
  kind: 'track' | 'branch' | 'commit' | 'rewrite' | 'step' | 'pane' | 'drift'
  /** 'outside' = git changed while this session was not running git. */
  origin: 'session' | 'outside'
  repo: string
  text: string
  hash?: string
  step?: string
}

export type Seen = { branch: string; heads: Record<string, string> }

export type Trail = {
  sessionId: string
  /** The desktop app's id for this session (`local_...`), for a link from other panes; unset in a terminal. */
  hostId?: string
  goal?: string
  whereWasI?: string
  phases: string[]
  steps: Step[]
  decisions: Decision[]
  events: TrailEvent[]
  /** Per repo root: the branch and the heads last seen. */
  seen: Record<string, Seen>
  turn: number
  planTurn: number
  planVersion: number
  /** 'tasks': the plan mirrors Claude's own task list (update_plan, TodoWrite) until Claude records one. */
  planFrom?: 'tasks'
  /** Commits since the plan was last saved. */
  commitsSincePlan: number
  /** Notes for Claude's next prompt: outside work, pane edits. */
  pending: string[]
  hasNudged: boolean
  updatedAt: number
  /** When the user last sent a message: "since you left" counts from here. */
  lastPromptAt: number
  /** The step that was current at the end of the last transcript scan. */
  activeStep?: string
  lastMsgUuid?: string
  /** The repo Claude touched last: new steps are placed there. */
  lastRepo?: string
  /** Files edited while no step was current. */
  unplannedFiles: string[]
  /** Wayfinder on in this session (/wayfinder, /wayfinder-off). Unset: on when it has a plan, else the autoStart setting. */
  isOn?: boolean
  /** Tokens Wayfinder added here, estimated at 4 characters a token: plan tool calls, notes, and turns the tool's description rode along. */
  cost?: { plan: number; notes: number; turns: number }
}

export type Lane = {
  branch: string
  /** 1 = this work, 0.55 = may matter, 0.25 = recent but unrelated. */
  relevance: number
  why: string
  isBase?: boolean
  isCurrent?: boolean
  tip: string
  /** The commit on another lane this branch grew from. */
  forkFrom?: string
}

/** `refs`: branches whose tip is this commit and that got no lane of their own. */
export type GraphCommit = { hash: string; parents: string[]; at: number; subject: string; lane: number; refs?: string[] }

export type Stash = { name: string; subject: string; at: number; parent: string; branch?: string }

export type RepoGraph = { lanes: Lane[]; commits: GraphCommit[]; stashes: Stash[]; hidden: number; skipped: number }

export type RepoLive = {
  root: string
  name: string
  branch: string
  head: string
  dirty: number
  dirtyFiles: string[]
  ahead?: number
  behind?: number
  base?: string
  sinceBase?: number
  behindBase?: number
  graph?: RepoGraph
}

declare module 'claude-code' {
  interface PluginState {
    wayfinder: {
      trail: Shaped<Trail | null>
      repos: Shaped<RepoLive[]>
      others: Shaped<Trail[]>
      expanded: Shaped<Record<string, boolean>>
      cleared: Shaped<Record<string, number>>
      aside: Shaped<{ title: string; text?: string; isLoading: boolean } | null>
      lang: Shaped<'en' | 'fr'>
      settings: Shaped<{ autoStart: boolean; othersDays: number; maxOthers: number; commitDates: boolean; maxCommits: number }>
    }
  }
}
