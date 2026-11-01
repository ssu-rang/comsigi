import { useEffect, useRef, type ReactNode } from "react"
import type { SeatStatus } from "./seats"
import { STATUS_LABEL } from "./domain"
import { ApiError, messageOf } from "./api"

type IconName = "search" | "chevron" | "arrow" | "star" | "clock" | "pin" | "refresh" | "info" | "close" | "plug" | "quiet" | "wifi" | "chat" | "chair" | "check"

export function Icon({ name, size = 18 }: {
  name: IconName
  size?: number
}) {
  const paths: Record<IconName, ReactNode> = {
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),

    chevron: <path d="m9 5 7 7-7 7" />,

    arrow: (
      <>
        <path d="M4 12h16m-6-6 6 6-6 6" />
      </>
    ),

    star: (
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />
    ),

    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7v5l3 2" />
      </>
    ),

    pin: (
      <>
        <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" />
        <circle cx="12" cy="10" r="2.3" />
      </>
    ),

    refresh: (
      <>
        <path d="M19.5 9a8 8 0 0 0-13-3L3 9m0-5v5h5M4.5 15a8 8 0 0 0 13 3l3.5-3m0 5v-5h-5" />
      </>
    ),

    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v.5" />
      </>
    ),

    close: <path d="m6 6 12 12M6 18 18 6" />,

    plug: (
      <>
        <path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0Zm6 10v4" />
      </>
    ),

    quiet: (
      <>
        <path d="m9 4 2-1m2 2c3 1 5 4 5 7v4l2 2H4l2-2v-4c0-1 .2-2 .5-3M10 21h4M3 3l18 18" />
      </>
    ),

    wifi: (
      <>
        <path d="M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0m-9 4a4 4 0 0 1 6 0" />
        <circle cx="12" cy="20" r=".7" />
      </>
    ),

    chat: <path d="M20 11a8 8 0 0 1-8 8H4l1-5a8 8 0 1 1 15-3Z" />,

    chair: (
      <>
        <path d="M7 12V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v7M5 12h14v5H5Zm2 5v4m10-4v4" />
      </>
    ),

    check: <path d="m5 12 4 4L19 6" />,
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

export function SeatButton({
  seat,
  selected,
  dimmed = false,
  onSelect,
}: {
  seat: {
    id: string
    number: number
    status: SeatStatus
  }
  selected: boolean
  dimmed?: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      className={`seat-button seat-${seat.status} ${
        selected ? "is-selected" : ""
      } ${dimmed ? "is-muted" : ""}`}
      aria-label={`${seat.number}번 좌석, ${STATUS_LABEL[seat.status]}`}
      title={`${seat.number}번 좌석 · ${STATUS_LABEL[seat.status]}`}
      aria-pressed={selected}
      onClick={() => onSelect(seat.id)}
    >
      <span className="chair-shape">
        <span>{String(seat.number).padStart(2, "0")}</span>
        {seat.status === "unknown" && <small>?</small>}
      </span>
    </button>
  )
}

export function ErrorNotice({
  error,
  retry,
}: {
  error: unknown
  retry?: () => void
}) {
  if (!error) return null
  return (
    <div className="notice error-notice" role="alert">
      <p>{messageOf(error)}</p>
      {error instanceof ApiError &&
        Object.entries(error.fields).map(([key, text]) => (
          <p key={key}>
            {key}: {text}
          </p>
        ))}
      {retry && (
        <button className="secondary-button" onClick={retry}>
          다시 시도
        </button>
      )}
    </div>
  )
}
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="data-state">
      <Icon name="chair" size={24} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}
export function Loading({
  label = "정보를 불러오고 있습니다",
}: {
  label?: string
}) {
  return (
    <div className="loading-state" role="status">
      <p>{label}</p>
      <div className="skeleton" />
      <div className="skeleton short" />
    </div>
  )
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    return () => ref.current?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="help-dialog form-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog-heading flex items-center justify-between">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="닫기">
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  )
}

export function Swatch({ status }: { status: SeatStatus }) {
  return <span className={`swatch swatch-${status}`} aria-hidden="true" />
}
