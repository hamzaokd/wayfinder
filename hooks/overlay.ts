// A transparent layer over the graph drawing: the drawing can't take clicks, this can.
// It maps a click to the row of the drawing under it and posts that row's id to the mod.
import type { ClientModule } from 'claude-code'

export type OverlayProps = { height: number; hits: { y1: number; y2: number; id: string }[] }

const GraphClicks: ClientModule<OverlayProps> = (props, surface) => {
  surface.onPointer(e => {
    if (e.type !== 'down' || (e.button !== undefined && e.button !== 'left')) return
    // The layer covers the drawing exactly, so its cells map to the drawing's pixels by proportion.
    const y = ((e.fine?.y ?? e.y + 0.5) / Math.max(1, surface.rows)) * props.height
    const hit = props.hits.find(h => y >= h.y1 && y <= h.y2)
    if (hit) surface.post({ id: hit.id })
  })
  return surface.elements.Box({ width: '100%', height: '100%' })
}

export default GraphClicks
