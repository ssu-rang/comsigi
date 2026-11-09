import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from scripts.simulate_device import DeviceClient, NewSessionRequired


@pytest.mark.parametrize("disconnect", [False, True])
def test_connection_reuse_and_retry_identical_report(monkeypatch, disconnect):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            requests.append((self.client_address, self.path, body))
            if disconnect and len(requests) == 2:
                self.close_connection = True
                return  # Simulate a lost report acknowledgement.
            payload = b'{"accepted":true}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    monkeypatch.setattr("scripts.simulate_device.time.sleep", lambda _: None)
    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = DeviceClient(f"http://127.0.0.1:{server.server_port}", "test-key")
        report = {"session_id": "test-session", "sequence": 1, "seats": []}
        try:
            client.post("session", {"device_uid": "camera-1"})
            assert client.post("reports", report) == {"accepted": True}
            assert requests[0][0] == requests[1][0]
            assert json.loads(requests[1][2]) == report
            assert b" " not in requests[1][2]
            if disconnect:
                assert len(requests) == 3
                assert requests[1][2] == requests[2][2]
        finally:
            client.close()
            server.shutdown()
            thread.join(timeout=5)


def test_idle_connection_closed_by_server_reconnects_without_waiting(monkeypatch):
    sleeps = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            payload = b"{}"
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            self.close_connection = True  # Idle timeout without "Connection: close".

        def log_message(self, *args):
            pass

    monkeypatch.setattr("scripts.simulate_device.time.sleep", sleeps.append)
    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = DeviceClient(f"http://127.0.0.1:{server.server_port}", "test-key")
        try:
            assert client.post("session", {}) == {}
            assert client.post("reports", {}) == {}
            assert sleeps == []
        finally:
            client.close()
            server.shutdown()
            thread.join(timeout=5)


def test_session_required_is_not_retried(monkeypatch):
    from unittest.mock import Mock

    client = DeviceClient("http://localhost", "test-key")
    response = Mock(status=409)
    response.read.return_value = b'{"error":{"code":"session_required"}}'
    connection = Mock()
    connection.getresponse.return_value = response
    monkeypatch.setattr(client, "connection", connection)
    with pytest.raises(NewSessionRequired):
        client.post("reports", {"sequence": 0})
    assert connection.request.call_count == 1
