// A transparent layer over the graph drawing: the drawing can't take clicks, this can.
// It maps the pointer to the row of the drawing under it: an outline on hover, the row's id on a click.
import type { ClientModule } from 'claude-code'

export type OverlayProps = { height: number; hits: { y1: number; y2: number; id: string }[] }
type State = { size: string; hover: string | null }

const GraphClicks: ClientModule<OverlayProps, State> = (props, surface) => {
  const { Box } = surface.elements
  const rows = Math.max(1, surface.rows)
  // The layer covers the drawing exactly, so its cells map to the drawing's pixels by proportion.
  const toPx = (cellY: number) => (cellY / rows) * props.height
  const toCell = (px: number) => Math.round((px / props.height) * rows)
  const at = (e: { y: number; fine?: { y: number } }) => {
    const y = toPx(e.fine?.y ?? e.y + 0.5)
    return { y, hit: props.hits.find(h => y >= h.y1 && y <= h.y2) }
  }
  const state = surface.state ?? { size: '', hover: null }

  // Report the layer's size once it has one, or again when it changes: a 0x1 layer takes no clicks.
  const size = `${surface.columns}x${surface.rows}`
  if (state.size !== size) {
    surface.post({ id: null, probe: { mounted: size } })
    surface.setState({ ...state, size })
  }

  surface.onPointer(e => {
    if (e.type === 'leave') {
      if (state.hover !== null) surface.setState({ ...state, hover: null })
      return
    }
    const { y, hit } = at(e)
    if (e.type === 'move') {
      const hover = hit?.id ?? null
      if (hover !== state.hover) surface.setState({ ...state, hover })
      return
    }
    if (e.type !== 'down' || (e.button !== undefined && e.button !== 'left')) return
    // `probe` says where the click landed, for the mod's diagnostics, hit or not.
    surface.post({ id: hit?.id ?? null, probe: { x: e.x, y: e.y, fineY: e.fine?.y ?? null, rows: surface.rows, columns: surface.columns, px: Math.round(y) } })
  })

  // An outline around the row under the pointer: what a click there would open.
  const hovered = props.hits.find(h => h.id === state.hover)
  return Box({
    width: '100%',
    height: '100%',
    children: hovered
      ? [Box({ key: 'hover', position: 'absolute', top: toCell(hovered.y1), left: 0, right: 0, height: Math.max(1, toCell(hovered.y2) - toCell(hovered.y1)), borderStyle: 'round', borderColor: 'suggestion' })]
      : [],
  })
}

export default GraphClicks
