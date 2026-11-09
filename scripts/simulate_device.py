"""A standard-library HTTP sensor simulator; no images or coordinates are sent."""

import argparse
import http.client
import json
import os
import time
from urllib.parse import urlparse


class NewSessionRequired(Exception):
    pass


class DeviceClient:
    """Reuse one HTTP(S) connection; reconnect and retry the identical batch on failure."""

    def __init__(self, base_url, credential):
        parsed = urlparse(base_url)
        connection = (
            http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        )
        self.connection = connection(parsed.hostname, parsed.port, timeout=5)
        self.prefix = parsed.path.rstrip("/") + "/api/v1/hardware/"
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + credential,
        }

    def close(self):
        self.connection.close()

    def post(self, path, body):
        data = json.dumps(body, separators=(",", ":")).encode()
        for attempt in range(3):
            try:
                self.connection.request("POST", self.prefix + path, body=data, headers=self.headers)
                response = self.connection.getresponse()
                # Drain the response before reusing the connection, including errors.
                payload = response.read()
                if 200 <= response.status < 300:
                    return json.loads(payload)
                try:
                    error = json.loads(payload).get("error", {})
                except (ValueError, AttributeError):
                    error = {}
                code = error.get("code", "http_error")
                if response.status == 409 and code == "session_required":
                    raise NewSessionRequired
                if response.status < 500 and response.status != 429:
                    raise SystemExit(f"Server rejected the report: HTTP {response.status}, {code}")
            except (http.client.HTTPException, OSError, ValueError):
                self.close()
                if attempt == 0:
                    continue  # The server may have closed the idle connection; reconnect now.
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
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.query
        or parsed.fragment
    ):
        parser.error("base-url must be an HTTP(S) server URL without credentials")
    base_url = args.base_url.rstrip("/")
    transport = DeviceClient(base_url, credential)
    session, sequence, cycle = None, 0, 0
    try:
        while args.cycles == 0 or cycle < args.cycles:
            if session is None:
                result = transport.post("session", {"device_uid": args.device_uid})
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
                result = transport.post("reports", body)
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
    finally:
        transport.close()


if __name__ == "__main__":
    main()
