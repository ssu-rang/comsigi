import type { SeatStatus } from "../data/types"

/** Miniature of a seat tile; doubles as the legend next to each count. */
export function Swatch({ status }: { status: SeatStatus }) {
  return <span className={`swatch swatch--${status}`} aria-hidden="true" />
}
