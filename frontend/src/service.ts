import type { SeatService } from "./domain"
import { backend } from "./backend"

// Vite eliminates this import in production. A query string/localStorage flag can
// never enable fixtures in a production build. No fallback on API errors.
export const service: SeatService =
  import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_DATA === "true"
    ? (await import("./dev/service")).devService
    : backend
