// For dev/preview.py: records what the pane draws in every fold state and what each step's dialog
// asks, so the HTML preview can answer clicks without running the mod. Copied into hooks/ for one run.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Dialog = { question: string; header?: string; options: string[] }

/** Answers the app's dialog by closing it, and keeps what it asked. Register before the session starts. */
export function captureDialogs(on: any): { last?: Dialog } {
  const box: { last?: Dialog } = {}
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => {
    const q = e.questions[0]
    box.last = { question: q.question, header: q.header, options: (q.options ?? []).map((o: { label: string }) => o.label) }
    return { result: { questions: [], answers: {} } }
  })
  return box
}

const MAX_PHASES = 5

/** Prints one PREVIEW line: the pane's tree for each set of folded-or-unfolded phases, and each step's dialog. */
export async function dump(ui: any, dialogs: { last?: Dialog }): Promise<void> {
  const keys = async () => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key ?? ''))
  const phases: string[] = (await keys()).filter((k: string) => k.includes('-phase:')).slice(0, MAX_PHASES)
  const trees: Record<string, unknown> = {}
  const asks: Record<string, Dialog | null> = {}
  for (let mask = 0; mask < 1 << phases.length; mask++) {
    const flipped = phases.filter((_, i) => mask & (1 << i))
    for (const k of flipped) await ui.press({ key: k })
    trees[[...flipped].sort().join('|')] = await ui.find({ type: 'Box' })
    for (const k of (await keys()).filter((k: string) => k.includes('-step:') && !(k in asks))) {
      dialogs.last = undefined
      await ui.press({ key: k })
      asks[k] = dialogs.last ?? null
    }
    for (const k of flipped) await ui.press({ key: k })
  }
  console.log('PREVIEW ' + JSON.stringify({ trees, asks }))
}
