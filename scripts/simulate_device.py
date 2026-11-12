"""A standard-library HTTP sensor simulator; no images or coordinates are sent."""

import argparse
import http.client
import json
import os
import time
import uuid
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


class PairingClient:
    """Self-registration requests; returns (HTTP status, JSON body) or (None, {}) when offline."""

    def __init__(self, base_url):
        parsed = urlparse(base_url)
        connection = (
            http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        )
        self.connection = connection(parsed.hostname, parsed.port, timeout=5)
        self.prefix = parsed.path.rstrip("/") + "/api/v1/"

    def close(self):
        self.connection.close()

    def post(self, path, body, token):
        data = json.dumps(body, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json", "Authorization": "Bearer " + token}
        for attempt in range(3):
            try:
                self.connection.request("POST", self.prefix + path, body=data, headers=headers)
                response = self.connection.getresponse()
                payload = response.read()
                return response.status, json.loads(payload) if payload else {}
            except (http.client.HTTPException, OSError, ValueError):
                self.close()
                if attempt < 2:
                    time.sleep(2**attempt)
        return None, {}


def hardware_uid():
    """Stand-in for a hardware identifier, e.g. hexlify(machine.unique_id()) on OpenMV."""
    return f"{uuid.getnode():012x}"


def pair(base_url, pairing_code, device_uid, seats, credential_file=None):
    """Register, wait for administrator approval, receive and confirm the device key."""
    client = PairingClient(base_url)
    try:
        # Retrying with the same code is safe: the server refreshes the registration secret.
        while True:
            status, body = client.post(
                "provisioning/register",
                {"device_uid": device_uid, "seat_numbers": seats},
                pairing_code,
            )
            if status in (200, 201):
                break
            if status is None or status == 429 or status >= 500:
                time.sleep(10)
                continue
            code = body.get("error", {}).get("code", "http_error")
            raise SystemExit(f"Pairing rejected: HTTP {status}, {code}")
        secret = body["registration_secret"]
        print("Registered; waiting for administrator approval.")
        credential = None
        while True:
            status, body = client.post("provisioning/status", {"device_uid": device_uid}, secret)
            if status is None or status == 429 or status >= 500:
                time.sleep(10)
                continue
            if status != 200:
                code = body.get("error", {}).get("code", "http_error")
                raise SystemExit(f"Registration status rejected: HTTP {status}, {code}")
            if body["status"] == "pending":
                time.sleep(body["retry_after_seconds"])
                continue
            if body["status"] == "completed" and credential:
                return credential  # The confirmation succeeded but its response was lost.
            if body["status"] != "approved":
                raise SystemExit(f"Registration {body['status']}; ask for a new pairing code")
            credential = body["credential"]  # Each approved poll revokes the previous key.
            if credential_file:
                with open(credential_file, "w", encoding="utf-8", opener=private_file) as file:
                    file.write(credential)
            status, _ = client.post(
                "hardware/registration/confirm", {"device_uid": device_uid}, credential
            )
            if status == 200:
                print("Device key received and confirmed.")
                return credential
            time.sleep(1)  # Poll again: a new key replaces the unconfirmed one.
    finally:
        client.close()


def private_file(path, flags):
    return os.open(path, flags, 0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--device-uid", help="defaults to this machine's hardware address")
    parser.add_argument("--seats", nargs="+", type=int, required=True)
    parser.add_argument("--interval", type=float, default=10)
    parser.add_argument("--cycles", type=int, default=0, help="0 runs until Ctrl+C")
    parser.add_argument(
        "--pair",
        action="store_true",
        help="self-register with COMSIGI_PAIRING_CODE instead of a pre-issued key",
    )
    parser.add_argument("--credential-file", help="with --pair, save the received key here")
    args = parser.parse_args()
    args.device_uid = args.device_uid or hardware_uid()
    credential = os.environ.get("COMSIGI_DEVICE_CREDENTIAL")
    pairing_code = os.environ.get("COMSIGI_PAIRING_CODE")
    if args.pair and not pairing_code:
        parser.error("Set COMSIGI_PAIRING_CODE to the code issued in the admin page")
    if not args.pair and not credential:
        parser.error("Set COMSIGI_DEVICE_CREDENTIAL to the issued device key, or use --pair")
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
    if args.pair:
        credential = pair(base_url, pairing_code, args.device_uid, args.seats, args.credential_file)
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
