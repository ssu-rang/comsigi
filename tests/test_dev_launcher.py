"""Development server supervision must stop every child on exit or startup failure."""

import socket
from unittest.mock import Mock

import pytest

from scripts import dev


@pytest.fixture
def launcher(monkeypatch):
    monkeypatch.setattr(dev.os, "chdir", lambda _: None)
    monkeypatch.setattr(dev.shutil, "which", lambda _: "npm")
    monkeypatch.setattr(dev, "check_port", lambda _: None)
    monkeypatch.setattr(dev.subprocess, "run", Mock())

    async def existing_admin():
        return True

    monkeypatch.setattr(dev, "admin_exists", existing_admin)
    stop = Mock()
    monkeypatch.setattr(dev, "stop_process", stop)
    return stop


def test_server_failure_stops_both_servers(launcher, monkeypatch):
    backend = Mock()
    backend.poll.return_value = None
    frontend = Mock()
    frontend.poll.return_value = 2
    monkeypatch.setattr(dev, "start_process", Mock(side_effect=[backend, frontend]))
    assert dev.main() == 2
    assert [call.args[0] for call in launcher.call_args_list] == [frontend, backend]


def test_second_start_failure_stops_backend(launcher, monkeypatch):
    backend = Mock()
    monkeypatch.setattr(
        dev, "start_process", Mock(side_effect=[backend, OSError("Cannot start frontend")])
    )
    with pytest.raises(OSError, match="Cannot start frontend"):
        dev.main()
    launcher.assert_called_once_with(backend)


def test_ctrl_c_stops_both_servers(launcher, monkeypatch):
    backend, frontend = Mock(), Mock()
    backend.poll.return_value = frontend.poll.return_value = None
    monkeypatch.setattr(dev, "start_process", Mock(side_effect=[backend, frontend]))
    monkeypatch.setattr(dev.time, "sleep", Mock(side_effect=KeyboardInterrupt))
    with pytest.raises(KeyboardInterrupt):
        dev.main()
    assert launcher.call_count == 2


def test_busy_port_has_clear_error():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        with pytest.raises(RuntimeError, match="already in use"):
            dev.check_port(listener.getsockname()[1])
