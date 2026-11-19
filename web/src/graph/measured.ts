// Whether React Flow has caught up with what the page draws: every shown node's measured size is the size of its element.
import type { FlowNode } from './types'

/** The size of a node's element on the page, or null when it is not drawn. */
export type DrawnSize = (id: string) => { width: number; height: number } | null

/** True when every node in `ids` is drawn and its measured size agrees with the element's (a pixel apart at most). */
export function sizesAgree(nodes: ReadonlyArray<Pick<FlowNode, 'id' | 'measured'>>, ids: ReadonlySet<string>, drawn: DrawnSize): boolean {
  return nodes
    .filter((n) => ids.has(n.id))
    .every((n) => {
      const el = drawn(n.id)
      return !!el && !!n.measured?.width && !!n.measured?.height && Math.abs(n.measured.width - el.width) <= 1 && Math.abs(n.measured.height - el.height) <= 1
    })
}

/** The size of the element React Flow draws for a node. */
export const drawnSize: DrawnSize = (id) => {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
  return el ? { width: el.offsetWidth, height: el.offsetHeight } : null
}

/** Polls until `agree()` holds on `steady` checks in a row, `stop()` says so, or `limitMs` pass (a node that never draws must not hold a lens switch for good). */
export async function untilSteady(agree: () => boolean, stop: () => boolean, { every = 50, steady = 3, limitMs = 8000 } = {}): Promise<void> {
  const end = Date.now() + limitMs
  let run = 0
  while (!stop() && Date.now() < end) {
    run = agree() ? run + 1 : 0
    if (run >= steady) return
    await new Promise((resolve) => setTimeout(resolve, every))
  }
}
