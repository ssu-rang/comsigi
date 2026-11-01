export class ApiError extends Error {
  status: number
  fields: Record<string, string>
  constructor(
    message: string,
    status = 0,
    fields: Record<string, string> = {},
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.fields = fields
  }
}
export const CONTRACT_MESSAGE =
  "공간 서비스 연결을 준비하고 있습니다. 연결이 완료되면 등록된 공간이 표시됩니다."
export const contractMissing = () => new ApiError(CONTRACT_MESSAGE, 501)
export function messageOf(error: unknown) {
  return error instanceof Error
    ? error.message
    : "요청을 처리하지 못했습니다. 다시 시도해 주세요."
}
export const apiBase = (import.meta.env?.VITE_API_BASE_URL ?? "").replace(
  /\/$/,
  "",
)
export async function requestJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timeout = setTimeout(abort, 10000)
  try {
    const response = await fetch(apiBase + path, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = body?.detail
      const fields: Record<string, string> = {}
      const details = body?.error?.details ?? detail
      if (Array.isArray(details))
        for (const item of details)
          fields[item.loc?.slice(1).join(".") ?? "request"] = String(item.msg)
      throw new ApiError(
        body?.error?.code === "invalid_credentials"
          ? "관리자 이름 또는 비밀번호가 올바르지 않습니다."
          : body?.error?.code === "layout_version_conflict"
            ? "다른 곳에서 배치가 변경되었습니다. 최신 배치를 확인해 주세요."
            : typeof body?.error?.message === "string"
              ? body.error.message
              : typeof detail === "string"
                ? detail
                : response.status === 401
                  ? "인증이 만료되었습니다. 다시 로그인해 주세요."
                  : `요청을 처리하지 못했습니다 (${response.status}).`,
        response.status,
        fields,
      )
    }
    if (body === null && response.status !== 204)
      throw new ApiError("서버 응답을 읽을 수 없습니다.")
    return body as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (options.signal?.aborted) throw error
    throw new ApiError(
      controller.signal.aborted
        ? "서버 응답 시간이 초과되었습니다. 다시 시도해 주세요."
        : "서버에 연결할 수 없습니다. 연결 상태를 확인해 주세요.",
    )
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abort)
  }
}
// Legacy endpoints retained for older callers.
export const checkHealth = () =>
  requestJson<{ status: string }>("/api/v1/health")
export const getLegacySeats = (signal?: AbortSignal) =>
  requestJson<{
    seats: {
      id: number
      status: string
    }[]
  }>("/api/v1/seats", {
    signal,
  })
