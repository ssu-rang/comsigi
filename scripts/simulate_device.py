"""A standard-library HTTP sensor simulator; no images or coordinates are sent."""

import argparse
import json
import os
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class NewSessionRequired(Exception):
    pass


def post(base_url, path, body, credential):
    request = Request(
        base_url + "/api/v1/hardware/" + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + credential},
        method="POST",
    )
    for attempt in range(3):
        try:
            with urlopen(request, timeout=5) as response:
                return json.load(response)
        except HTTPError as exc:
            try:
                error = json.loads(exc.read(4096)).get("error", {})
            except (ValueError, AttributeError):
                error = {}
            code = error.get("code", "http_error")
            if exc.code == 409 and code == "session_required":
                raise NewSessionRequired from exc
            if exc.code < 500 and exc.code != 429:
                raise SystemExit(f"Server rejected the report: HTTP {exc.code}, {code}") from exc
        except (URLError, TimeoutError, OSError):
            pass
        if attempt < 2:
            time.sleep(2**attempt)
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--device-uid", required=True)
    parser.add_argument("--seats", nargs="+", type=int, required=True)
    parser.add_argument("--interval", type=float, default=10)
    parser.add_argument("--cycles", type=int, default=0, help="0 runs until Ctrl+C")
    args = parser.parse_args()
    credential = os.environ.get("COMSIGI_DEVICE_CREDENTIAL")
    if not credential:
        parser.error("Set COMSIGI_DEVICE_CREDENTIAL to the issued device key")
    if args.interval <= 0 or args.cycles < 0:
        parser.error("interval must be positive and cycles must be nonnegative")
    if len(args.seats) > 500 or len(set(args.seats)) != len(args.seats) or min(args.seats) <= 0:
        parser.error("Provide 1–500 distinct positive seat numbers")
    parsed = urlparse(args.base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username:
        parser.error("base-url must be an HTTP(S) server URL without credentials")
    base_url = args.base_url.rstrip("/")
    session, sequence, cycle = None, 0, 0
    try:
        while args.cycles == 0 or cycle < args.cycles:
            if session is None:
                result = post(base_url, "session", {"device_uid": args.device_uid}, credential)
                if result is None:
                    print("Server unreachable; retrying session in 5 seconds.")
                    time.sleep(5)
                    continue
                session, sequence = result["session_id"], 0
                timeout = min(result["device_timeout_seconds"], result["seat_timeout_seconds"])
                if args.interval >= timeout:
                    print(f"The interval exceeds the freshness window ({timeout}s).")
            # Substitute current sensor readings here in real firmware.
            seats = [
                {"number": number, "occupied": bool((cycle + index) % 2)}
                for index, number in enumerate(args.seats)
            ]
            body = {
                "device_uid": args.device_uid,
                "session_id": session,
                "sequence": sequence,
                "seats": seats,
            }
            try:
                result = post(base_url, "reports", body, credential)
            except NewSessionRequired:
                session = None
                time.sleep(1)
                continue
            if result is None:
                print("Report unacknowledged; next cycle samples current readings.")
            else:
                print(f"sequence={sequence} accepted={result['accepted']} seats={seats}")
            sequence += 1
            cycle += 1
            if args.cycles == 0 or cycle < args.cycles:
                time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nSimulator stopped.")


if __name__ == "__main__":
    main()
