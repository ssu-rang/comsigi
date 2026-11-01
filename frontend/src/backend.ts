import type { PlaceInput, SeatService, Session } from "./domain.ts"
import { apiBase, ApiError, requestJson } from "./api.ts"
import {
  array,
  decodeDevice,
  decodeEvent,
  decodeLayout,
  decodePlace,
  object,
  serverId,
  string,
  number,
} from "./backend-contract.ts"
import { connectSocket } from "./realtime.ts"
import { saveBackendLayout } from "./backend-layout.ts"

export type Request = <T = unknown,>(
  path: string,
  options?: RequestInit,
) => Promise<T>
const body = (value: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
})
const placeBody = (p: PlaceInput) => ({
  name: p.name,
  slug: p.slug,
  description: p.description,
  canvas_width: p.canvasWidth,
  canvas_height: p.canvasHeight,
})
export function createBackend(request: Request = requestJson): SeatService {
  let token: string | null = null,
    expiresAt = ""
  const expire = () => {
    token = null
    globalThis.window?.dispatchEvent(new Event("auth-expired"))
  }
  const admin: Request = async (path, options = {}) => {
    if (!token || Date.parse(expiresAt) <= Date.now()) {
      expire()
      throw new ApiError("인증이 만료되었습니다. 다시 로그인해 주세요.", 401)
    }
    const headers = new Headers(options.headers)
    headers.set("Authorization", `Bearer ${token}`)
    try {
      return await request(path, { ...options, headers })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expire()
      throw error
    }
  }
  const places = async (signal?: AbortSignal) =>
    array(await request("/api/v1/places", { signal })).map((value) =>
      decodePlace(value),
    )
  const resolve = async (id: string, signal?: AbortSignal) => {
    const place = (await places(signal)).find((p) => p.id === id)
    if (!place) throw new ApiError("공간을 찾을 수 없습니다.", 404)
    return place
  }
  const snapshot = async (id: string, signal?: AbortSignal) => {
    const p = await resolve(id, signal)
    return object(
      await request(`/api/v1/places/${encodeURIComponent(p.slug)}/snapshot`, {
        signal,
      }),
    )
  }
  const me = async (): Promise<Session> => {
    const user = object(await admin("/api/v1/auth/me"))
    return { name: string(user.username), role: "admin", expiresAt }
  }
  return {
    mode: "api",
    async listPlaces(signal) {
      const list = await places(signal)
      return (
        await Promise.all(
          list.map(async (p) => {
            try {
              const snap = object(
                await request(
                  `/api/v1/places/${encodeURIComponent(p.slug)}/snapshot`,
                  { signal },
                ),
              )
              return decodePlace(object(snap.layout).place, snap.state)
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) return null
              throw error
            }
          }),
        )
      ).filter((p): p is NonNullable<typeof p> => p !== null)
    },
    async getPlace(id, signal) {
      const s = await snapshot(id, signal)
      return decodePlace(object(s.layout).place, s.state)
    },
    async getLayout(id, signal) {
      return decodeLayout((await snapshot(id, signal)).layout)
    },
    async session() {
      if (!token) return null
      try {
        return await me()
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null
        throw error
      }
    },
    async login(username, password) {
      const result = object(
        await request("/api/v1/auth/token", {
          method: "POST",
          ...body({ username, password }),
        }),
      )
      token = string(result.access_token)
      expiresAt = new Date(
        Date.now() + number(result.expires_in) * 1000,
      ).toISOString()
      try {
        return await me()
      } catch (error) {
        token = null
        throw error
      }
    },
    async logout() {
      try {
        if (token) await admin("/api/v1/auth/token", { method: "DELETE" })
      } finally {
        expire()
      }
    },
    async createPlace(input) {
      return decodePlace(
        await admin("/api/v1/admin/places", {
          method: "POST",
          ...body(placeBody(input)),
        }),
      )
    },
    async updatePlace(id, input) {
      return decodePlace(
        await admin(`/api/v1/admin/places/${serverId(id)}`, {
          method: "PATCH",
          ...body(placeBody(input)),
        }),
      )
    },
    async deletePlace(id) {
      await admin(`/api/v1/admin/places/${serverId(id)}`, { method: "DELETE" })
    },
    saveLayout: (layout) => saveBackendLayout(layout, admin),
    async listDevices(signal) {
      return array(await admin("/api/v1/admin/devices", { signal })).map(
        decodeDevice,
      )
    },
    async createDevice(input) {
      const result = object(
        await admin("/api/v1/admin/devices", {
          method: "POST",
          ...body({
            device_uid: input.identifier,
            name: input.name,
            place_id: serverId(input.placeId),
            enabled: input.enabled,
          }),
        }),
      )
      return {
        device: decodeDevice(result.device),
        token: string(result.credential),
      }
    },
    async updateDevice(id, input) {
      return decodeDevice(
        await admin(`/api/v1/admin/devices/${serverId(id)}`, {
          method: "PATCH",
          ...body({
            name: input.name,
            place_id: serverId(input.placeId),
            enabled: input.enabled,
          }),
        }),
      )
    },
    async rotateToken(id) {
      return string(
        object(
          await admin(
            `/api/v1/admin/devices/${serverId(id)}/rotate-credential`,
            { method: "POST" },
          ),
        ).credential,
      )
    },
    subscribe(id, sink) {
      return connectSocket(
        id,
        {
          url: async () => {
            // Resolve on reconnect because the public URL uses a mutable slug.
            let p
            try {
              p = await resolve(id)
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) return null
              throw error
            }
            const url = new URL(
              `${apiBase}/api/v1/places/${encodeURIComponent(p.slug)}/ws`,
              globalThis.location.href,
            )
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
            return url.href
          },
          decode: decodeEvent,
          heartbeat: { intervalMs: 15000, payload: '{"type":"ping"}' },
          silenceTimeoutMs: 45000,
        },
        sink,
      )
    },
  }
}
export const backend = createBackend()
