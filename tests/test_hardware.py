from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import event


def test_reports_idempotency_order_and_atomic_validation(api, setup_room):
    place, _, device = setup_room
    assert api.state(place)["summary"] == {"total": 1, "available": 0, "occupied": 0, "unknown": 1}
    session = api.session(device)
    seats = [{"number": 1, "occupied": True}]
    first = api.report(device, session, 10, seats)
    duplicate = api.report(device, session, 10, seats)
    assert first["accepted"] and duplicate["duplicate"]
    assert first["revision"] == duplicate["revision"]
    api.report(device, session, 9, seats, expected=409)
    api.report(device, session, 10, [{"number": 1, "occupied": False}], expected=409)
    api.report(
        device,
        session,
        11,
        [{"number": 1, "occupied": False}, {"number": 999, "occupied": True}],
        expected=422,
    )
    assert api.state(place)["seats"][0]["status"] == "occupied"
    # Invalid batches do not consume the sequence.
    api.report(device, session, 11, [{"number": 1, "occupied": False}])
    assert api.state(place)["summary"]["available"] == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"sequence": True},
        {"sequence": -1},
        {"sequence": 1.5},
        {"seats": [{"number": 1, "occupied": "false"}]},
        {"seats": [{"number": 1, "occupied": 0}]},
        {"seats": [{"number": 1, "occupied": True, "x": 10}]},
        {"seats": [{"number": 1, "occupied": True}] * 2},
        {"image": "not-accepted"},
        {"place_id": 2},
    ],
)
def test_strict_hardware_contract(api, client, setup_room, changes):
    _, _, device = setup_room
    session = api.session(device)
    body = {"device_uid": "camera-1", "session_id": session, "sequence": 0, "seats": []}
    response = client.post(
        "/api/v1/hardware/reports", json={**body, **changes}, headers=api.device_headers(device)
    )
    assert response.status_code == 422, response.text


def test_overlapping_devices_use_fresh_occupied_precedence(api, client, setup_room):
    place, _, first = setup_room
    second = api.device(place, "camera-2")
    session1, session2 = api.session(first), api.session(second)
    api.report(first, session1, 0, [{"number": 1, "occupied": True}])
    client.portal.call(client.app.state.runtime.clock.advance, 20)
    api.report(second, session2, 0, [{"number": 1, "occupied": False}])
    assert api.state(place)["seats"][0]["status"] == "occupied"
    client.portal.call(client.app.state.runtime.clock.advance, 11)
    state = api.state(place)
    assert state["seats"][0]["status"] == "available"
    assert state["devices"][0]["status"] == "offline"
    client.portal.call(client.app.state.runtime.clock.advance, 20)
    assert api.state(place)["seats"][0]["status"] == "unknown"


def test_heartbeat_does_not_refresh_seats_or_resurrect_expired_observations(
    api, client, setup_room
):
    place, _, device = setup_room
    session = api.session(device)
    seats = [{"number": 1, "occupied": True}]
    api.report(device, session, 0, seats)
    stamp = api.state(place)["seats"][0]["last_received_at"]
    client.portal.call(client.app.state.runtime.clock.advance, 20)
    api.report(device, session, 1, [])
    client.portal.call(client.app.state.runtime.clock.advance, 11)
    state = api.state(place)
    assert state["devices"][0]["status"] == "online"
    assert state["seats"][0]["status"] == "unknown"
    assert state["seats"][0]["last_received_at"] == stamp
    client.portal.call(client.app.state.runtime.clock.advance, 31)
    api.report(device, session, 2, [])
    assert api.state(place)["seats"][0]["status"] == "unknown"
    api.report(device, session, 3, seats)
    assert api.state(place)["seats"][0]["status"] == "occupied"


def test_duplicate_does_not_keep_device_alive_and_reboot_rejects_old_session(
    api, client, setup_room
):
    place, _, device = setup_room
    session = api.session(device)
    api.report(device, session, 0, [{"number": 1, "occupied": True}])
    client.portal.call(client.app.state.runtime.clock.advance, 31)
    api.report(device, session, 0, [{"number": 1, "occupied": True}])
    assert api.state(place)["devices"][0]["status"] == "offline"
    new_session = api.session(device)
    assert new_session != session
    api.report(device, session, 1, [], expected=409)
    api.report(device, new_session, 0, [{"number": 1, "occupied": False}])
    assert api.state(place)["seats"][0]["status"] == "available"


def test_hardware_path_performs_no_sql(api, client, setup_room):
    place, _, device = setup_room
    engine = client.app.state.session_factory.kw["bind"].sync_engine
    statements = []

    def record(_conn, _cursor, statement, _params, _context, _many):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        session = api.session(device)
        for sequence in range(5):
            api.report(device, session, sequence, [{"number": 1, "occupied": bool(sequence % 2)}])
        api.state(place)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert statements == []


def test_concurrent_reports_cannot_roll_state_back(api, client, setup_room):
    place, _, device = setup_room
    session = api.session(device)

    def report(sequence):
        return client.post(
            "/api/v1/hardware/reports",
            headers=api.device_headers(device),
            json={
                "device_uid": "camera-1",
                "session_id": session,
                "sequence": sequence,
                "seats": [{"number": 1, "occupied": bool(sequence % 2)}],
            },
        )

    with ThreadPoolExecutor(max_workers=6) as executor:
        responses = list(executor.map(report, range(20)))
    assert all(response.status_code in {200, 409} for response in responses)
    assert api.state(place)["seats"][0]["status"] == "occupied"  # Sequence 19 wins.
    assert client.app.state.runtime.device_sessions[device["device"]["id"]].sequence == 19
