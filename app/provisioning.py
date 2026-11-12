"""Camera self-registration helpers: failure limiting and default seat placement.

Registrations and pairing codes live in SQLite, so pending requests survive a
restart. Only the failure counters and the recent-failure list shown to
administrators are process-local diagnostics.
"""

import time
from collections import deque
from datetime import UTC, datetime

from app.errors import DomainError

SEAT_SIZE = 40.0
SEAT_GAP = 20.0
MARGIN = 40.0
MAX_CANVAS = 100000.0


def aware(value: datetime | None) -> datetime | None:
    """SQLite returns naive datetimes; every stored value is UTC."""
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


class ProvisioningState:
    """Limit unauthenticated pairing attempts per client and keep a short failure log."""

    window_seconds = 60
    max_failures = 10
    max_clients = 4096

    def __init__(self):
        self.failures: dict[str, tuple[float, int]] = {}
        self.recent: deque[dict] = deque(maxlen=50)

    def check(self, client: str):
        now = time.monotonic()
        self.failures = {k: v for k, v in self.failures.items() if now - v[0] < self.window_seconds}
        _, count = self.failures.get(client, (now, 0))
        if count >= self.max_failures:
            raise DomainError(429, "pairing_rate_limited", "Too many failed attempts; retry later")

    def fail(
        self, client: str, device_uid: str | None, status: int, code: str, message: str
    ) -> DomainError:
        now = time.monotonic()
        if client in self.failures or len(self.failures) < self.max_clients:
            start, count = self.failures.get(client, (now, 0))
            self.failures[client] = start, count + 1
        # device_uid already passed the strict pattern check; secrets are never recorded.
        self.recent.appendleft(
            {"device_uid": device_uid, "reason": code, "at": datetime.now(UTC).isoformat()}
        )
        return DomainError(status, code, message)


def _overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah


def plan_seat_positions(
    canvas_width: float,
    canvas_height: float,
    occupied: list[tuple[float, float, float, float]],
    count: int,
) -> tuple[list[tuple[float, float]], float]:
    """Place new 40x40 seats on a row-major grid, skipping cells that touch existing items.

    Returns the positions and the canvas height needed to contain them (never smaller
    than the current height). Administrators move seats afterwards in the layout editor.
    """
    if count == 0:
        return [], canvas_height
    if canvas_width < SEAT_SIZE:
        raise DomainError(422, "canvas_too_small", "Canvas is narrower than one seat")
    margin = MARGIN if canvas_width >= SEAT_SIZE + 2 * MARGIN else 0.0
    step = SEAT_SIZE + SEAT_GAP
    columns = max(1, int((canvas_width - 2 * margin - SEAT_SIZE) // step) + 1)
    # Keep a gap around existing items so generated seats do not visually touch them.
    padded = [
        (x - SEAT_GAP / 2, y - SEAT_GAP / 2, w + SEAT_GAP, h + SEAT_GAP) for x, y, w, h in occupied
    ]
    positions: list[tuple[float, float]] = []
    row = 0
    while len(positions) < count:
        y = margin + row * step
        if y + SEAT_SIZE > MAX_CANVAS:
            raise DomainError(422, "canvas_too_small", "Not enough room for the reported seats")
        for column in range(columns):
            cell = (margin + column * step, y, SEAT_SIZE, SEAT_SIZE)
            if not any(_overlaps(cell, box) for box in padded):
                positions.append(cell[:2])
                if len(positions) == count:
                    break
        row += 1
    bottom = max(y for _, y in positions) + SEAT_SIZE + margin
    return positions, max(canvas_height, min(bottom, MAX_CANVAS))
