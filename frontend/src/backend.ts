import type { SeatService } from "./domain"
import { contractMissing } from "./api"

// Integration seam. The current backend has no place, auth, layout, device or WS
// contract. Do not invent URLs here or turn its global /seats into a fake place.
// Implement this object ONLY after inspecting the actual backend/OpenAPI/events.
const unavailable = async (): Promise<never> => {
  throw contractMissing()
}
export const backend: SeatService = {
  mode: "unconfigured",
  listPlaces: unavailable,
  getPlace: unavailable,
  getLayout: unavailable,
  session: async () => null,
  login: unavailable,
  logout: unavailable,
  createPlace: unavailable,
  updatePlace: unavailable,
  deletePlace: unavailable,
  saveLayout: unavailable,
  listDevices: unavailable,
  createDevice: unavailable,
  updateDevice: unavailable,
  rotateToken: unavailable,
  subscribe: (_id, sink) => {
    sink.connection("unsupported")
    return () => {}
  },
}
