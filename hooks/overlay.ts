// A transparent layer over the graph drawing: the drawing can't take clicks, this can.
// It maps a click to the row of the drawing under it and posts that row's id to the mod.
import type { ClientModule } from 'claude-code'

export type OverlayProps = { height: number; hits: { y1: number; y2: number; id: string }[] }

const GraphClicks: ClientModule<OverlayProps, string> = (props, surface) => {
  // Report the layer's size once it has one (or again when it changes): a 0x0 layer takes no clicks.
  const size = `${surface.columns}x${surface.rows}`
  if (surface.state !== size) {
    surface.post({ id: null, probe: { mounted: size } })
    surface.setState(size)
  }
  surface.onPointer(e => {
    if (e.type !== 'down' || (e.button !== undefined && e.button !== 'left')) return
    // The layer covers the drawing exactly, so its cells map to the drawing's pixels by proportion.
    const y = ((e.fine?.y ?? e.y + 0.5) / Math.max(1, surface.rows)) * props.height
    const hit = props.hits.find(h => y >= h.y1 && y <= h.y2)
    // `probe` says where the click landed, for the mod's diagnostics, hit or not.
    surface.post({ id: hit?.id ?? null, probe: { x: e.x, y: e.y, fineY: e.fine?.y ?? null, rows: surface.rows, columns: surface.columns, px: Math.round(y) } })
  })
  return surface.elements.Box({ width: '100%', height: '100%' })
}

export default GraphClicks
