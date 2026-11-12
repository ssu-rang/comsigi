import sqlite3
from datetime import timedelta

import pytest
from conftest import API, PASSWORD
from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url

from app.main import create_app
from app.models import utcnow
from app.provisioning import plan_seat_positions

UID = "e6614103e7a5b52b"  # e.g. an OpenMV machine.unique_id() hex string


def issue_code(api):
    return api.post("/pairing-codes", {})["code"]


def register(client, code, uid=UID, expected=201, **body):
    headers = {"Authorization": f"Bearer {code}"} if code else {}
    response = client.post(
        "/api/v1/provisioning/register", json={"device_uid": uid, **body}, headers=headers
    )
    assert response.status_code == expected, response.text
    return response.json()


def poll(client, secret, uid=UID, expected=200):
    response = client.post(
        "/api/v1/provisioning/status",
        json={"device_uid": uid},
        headers={"Authorization": f"Bearer {secret}"},
    )
    assert response.status_code == expected, response.text
    return response


def registration(api, uid=UID):
    response = api.client.get("/api/v1/admin/device-registrations", headers=api.headers)
    assert response.status_code == 200, response.text
    return next(r for r in response.json() if r["device_uid"] == uid)


def approve(api, reg, place, expected=200, **body):
    return api.post(
        f"/device-registrations/{reg['id']}/approve",
        {"place_id": place["id"], "name": "Entrance camera", **body},
        expected=expected,
    )


def shift_clock(monkeypatch, seconds):
    shifted = utcnow() + timedelta(seconds=seconds)
    monkeypatch.setattr("app.api.provisioning.utcnow", lambda: shifted)


def device_of(credential, uid=UID):
    return {"device": {"device_uid": uid}, "credential": credential}


def test_full_pairing_flow_delivers_credential_and_creates_seats(api, client):
    place = api.place()
    code = issue_code(api)
    accepted = register(client, code, seat_numbers=[3, 1, 2], model="OpenMV H7")
    assert accepted["status"] == "pending" and accepted["retry_after_seconds"] == 10
    secret = accepted["registration_secret"]

    pending = poll(client, secret)
    assert pending.json()["status"] == "pending" and pending.json()["retryable"] is True
    assert pending.headers["Retry-After"] == "10"
    reg = registration(api)
    assert reg["status"] == "pending" and reg["seat_numbers"] == [1, 2, 3]
    assert reg["model"] == "OpenMV H7"

    approved = approve(api, reg, place)
    assert approved["seats_created"] == [1, 2, 3] and approved["seats_existing"] == []
    assert approved["device"]["device_uid"] == UID and "credential" not in approved
    layout = api.client.get(f"/api/v1/places/{place['slug']}/layout").json()
    assert sorted(s["number"] for s in layout["seats"]) == [1, 2, 3]
    for seat in layout["seats"]:
        assert seat["x"] + seat["width"] <= layout["place"]["canvas_width"]
        assert seat["y"] + seat["height"] <= layout["place"]["canvas_height"]

    # A lost response is recovered by polling again; the previous key stops working.
    first = poll(client, secret).json()
    second = poll(client, secret).json()
    assert first["status"] == second["status"] == "approved"
    assert first["credential"] != second["credential"]
    unauthorized = client.post(
        "/api/v1/hardware/session",
        json={"device_uid": UID},
        headers={"Authorization": "Bearer " + first["credential"]},
    )
    assert unauthorized.status_code == 401
    device = device_of(second["credential"])
    session = api.session(device)
    api.report(device, session, 0, [{"number": 2, "occupied": True}])
    assert api.state(place)["summary"]["occupied"] == 1

    for _ in range(2):  # Idempotent confirmation.
        confirm = client.post(
            "/api/v1/hardware/registration/confirm",
            json={"device_uid": UID},
            headers=api.device_headers(device),
        )
        assert confirm.status_code == 200 and confirm.json() == {"status": "completed"}
    done = poll(client, secret).json()
    assert done == {
        "status": "completed",
        "retryable": False,
        "retry_after_seconds": None,
        "expires_at": None,
        "credential": None,
    }
    api.report(device, session, 1, [{"number": 2, "occupied": False}])  # Key not rotated.
    assert registration(api)["status"] == "completed"


def test_pairing_code_is_required_single_use_and_expiring(api, client, monkeypatch):
    register(client, None, expected=401)
    register(client, "not-a-real-code", expected=401)
    code = issue_code(api)
    first = register(client, code, seat_count=2)
    # Retrying with the same code and UID refreshes the secret (lost response recovery).
    retry = register(client, code, expected=200, seat_count=2)
    assert retry["registration_secret"] != first["registration_secret"]
    assert retry["expires_at"] == first["expires_at"]
    poll(client, first["registration_secret"], expected=401)
    poll(client, retry["registration_secret"])
    poll(client, retry["registration_secret"], uid="other-uid", expected=401)
    # A used code cannot register another UID.
    used = register(client, code, uid="intruder", expected=401)
    assert used["error"]["code"] == "pairing_code_used"

    expiring = issue_code(api)
    shift_clock(monkeypatch, 901)
    expired = register(client, expiring, uid="late-camera", expected=401)
    assert expired["error"]["code"] == "pairing_code_expired"
    retry_after_expiry = register(client, code, expected=401)  # Retry window closed too.
    assert retry_after_expiry["error"]["code"] == "pairing_code_expired"
    monkeypatch.undo()

    revoked = api.post("/pairing-codes", {})
    response = client.delete(f"/api/v1/admin/pairing-codes/{revoked['id']}", headers=api.headers)
    assert response.status_code == 204
    register(client, revoked["code"], uid="revoked-camera", expected=401)

    codes = client.get("/api/v1/admin/pairing-codes", headers=api.headers).json()
    assert {c["status"] for c in codes} == {"used", "active", "revoked"}
    assert all("code" not in c and "token_hash" not in c for c in codes)
    failures = client.get("/api/v1/admin/provisioning-failures", headers=api.headers).json()
    reasons = {f["reason"] for f in failures}
    assert {"pairing_unauthorized", "pairing_code_used", "pairing_code_expired"} <= reasons
    assert code not in str(failures) and revoked["code"] not in str(failures)


def test_failed_attempts_are_rate_limited(api, client):
    for _ in range(10):
        register(client, "wrong-code", expected=401)
    limited = client.post(
        "/api/v1/provisioning/register",
        json={"device_uid": UID},
        headers={"Authorization": "Bearer " + issue_code(api)},
    )
    assert limited.status_code == 429 and limited.headers["Retry-After"] == "60"


def test_registered_uid_is_rejected_without_consuming_the_code(api, client):
    place = api.place()
    api.device(place, UID)
    code = issue_code(api)
    conflict = register(client, code, expected=409)
    assert conflict["error"]["code"] == "device_already_registered"
    api.delete(
        f"/devices/{api.client.get('/api/v1/admin/devices', headers=api.headers).json()[0]['id']}"
    )
    register(client, code)  # Still usable after the old device is removed.


def test_approval_is_idempotent_and_never_overwrites_existing_seats(api, client):
    place = api.place()
    other = api.place("other")
    kept = api.seat(place, number=2, x=40, y=40, label="window")
    secret = register(client, issue_code(api), seat_numbers=[1, 2, 3])["registration_secret"]
    reg = registration(api)
    first = approve(api, reg, place)
    assert first["seats_created"] == [1, 3] and first["seats_existing"] == [2]
    again = approve(api, reg, place)
    assert again["seats_created"] == [] and again["seats_existing"] == [1, 2, 3]
    assert again["device"]["id"] == first["device"]["id"]
    conflict = approve(api, reg, other, expected=409)
    assert conflict["error"]["code"] == "registration_already_approved"

    seats = {
        s["number"]: s
        for s in api.client.get(f"/api/v1/places/{place['slug']}/layout").json()["seats"]
    }
    assert seats[2] == kept
    assert len(seats) == 3
    boxes = [(s["x"], s["y"], s["width"], s["height"]) for s in seats.values()]
    for i, a in enumerate(boxes):  # Generated seats do not overlap the existing one.
        for b in boxes[i + 1 :]:
            assert not (
                a[0] < b[0] + b[2]
                and b[0] < a[0] + a[2]
                and a[1] < b[1] + b[3]
                and b[1] < a[1] + a[3]
            )
    assert poll(client, secret).json()["status"] == "approved"


def test_reregistration_with_fewer_seats_never_deletes(api, client):
    place = api.place()
    register(client, issue_code(api), seat_count=3)
    approved = approve(api, registration(api), place)
    api.delete(f"/devices/{approved['device']['id']}")
    assert registration(api)["status"] == "removed"
    register(client, issue_code(api), seat_count=1)
    again = approve(api, registration(api), place)
    assert again["seats_created"] == [] and again["seats_existing"] == [1]
    assert api.state(place)["summary"]["total"] == 3


def test_expired_and_rejected_registrations(api, client, monkeypatch):
    place = api.place()
    secret = register(client, issue_code(api), uid="cam-expired")["registration_secret"]
    shift_clock(monkeypatch, 86401)
    assert poll(client, secret, uid="cam-expired").json()["status"] == "expired"
    reg = registration(api, "cam-expired")
    assert reg["status"] == "expired"
    assert approve(api, reg, place, expected=409)["error"]["code"] == "registration_expired"
    monkeypatch.undo()

    secret = register(client, issue_code(api))["registration_secret"]
    reg = registration(api)
    rejected = api.post(f"/device-registrations/{reg['id']}/reject", {}, expected=200)
    assert rejected["status"] == "rejected"
    body = poll(client, secret).json()
    assert body["status"] == "rejected" and body["retryable"] is False
    assert body["credential"] is None
    assert approve(api, reg, place, expected=409)["error"]["code"] == "registration_rejected"
    # A new pairing code starts over.
    fresh = register(client, issue_code(api))["registration_secret"]
    poll(client, secret, expected=401)
    assert poll(client, fresh).json()["status"] == "pending"


def test_failed_approval_leaves_no_partial_data(api, client):
    narrow = api.post("/places", {"name": "narrow", "slug": "narrow", "canvas_width": 30})
    register(client, issue_code(api), seat_count=2)
    reg = registration(api)
    failed = approve(api, reg, narrow, expected=422)
    assert failed["error"]["code"] == "canvas_too_small"
    assert client.get("/api/v1/admin/devices", headers=api.headers).json() == []
    assert api.state(narrow)["summary"]["total"] == 0
    assert registration(api)["status"] == "pending"
    approve(api, reg, api.place())  # The same request can be retried elsewhere.


def test_pending_registration_survives_restart(settings):
    with TestClient(create_app(settings)) as client:
        login = client.post("/api/v1/auth/token", json={"username": "admin", "password": PASSWORD})
        api = API(client, {"Authorization": "Bearer " + login.json()["access_token"]})
        place = api.place()
        secret = register(client, issue_code(api), seat_count=1)["registration_secret"]
    with TestClient(create_app(settings)) as client:
        login = client.post("/api/v1/auth/token", json={"username": "admin", "password": PASSWORD})
        api = API(client, {"Authorization": "Bearer " + login.json()["access_token"]})
        assert poll(client, secret).json()["status"] == "pending"
        approve(api, registration(api), place)
        credential = poll(client, secret).json()["credential"]
    with TestClient(create_app(settings)) as client:
        # The delivered key is persisted (hashed) and works after another restart.
        api = API(client, {})
        api.session(device_of(credential))
    connection = sqlite3.connect(make_url(settings.database_url).database)
    try:
        stored = " ".join(
            str(row)
            for table in ("pairing_tokens", "device_registrations", "devices")
            for row in connection.execute(f"SELECT * FROM {table}")
        )
        assert secret not in stored and credential not in stored
    finally:
        connection.close()


def test_authentication_scopes_are_separate(api, client):
    code = issue_code(api)
    secret = register(client, code)["registration_secret"]
    for token in (code, secret):
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/v1/admin/device-registrations", headers=headers).status_code == 401
        response = client.post(
            "/api/v1/hardware/session", json={"device_uid": UID}, headers=headers
        )
        assert response.status_code == 401
    assert client.post("/api/v1/admin/pairing-codes").status_code == 401
    # Public endpoints never mention registrations or UIDs.
    place = api.place()
    approve(api, registration(api), place)
    assert UID not in client.get(f"/api/v1/places/{place['slug']}/snapshot").text


def test_provisioning_body_size_is_limited(client):
    huge = b'{"device_uid":"a","seat_numbers":[' + b"1," * 40_000 + b"1]}"
    response = client.post(
        "/api/v1/provisioning/register",
        content=huge,
        headers={"Content-Type": "application/json", "Authorization": "Bearer x"},
    )
    assert response.status_code == 413


@pytest.mark.parametrize(
    "body",
    [
        {"seat_numbers": [1, 1]},
        {"seat_numbers": [0]},
        {"seat_numbers": [1], "seat_count": 1},
        {"seat_count": 501},
        {"device_uid": "bad uid"},
        {"place_id": 1},
    ],
)
def test_registration_contract_is_strict(api, client, body):
    response = client.post(
        "/api/v1/provisioning/register",
        json={"device_uid": UID, **body},
        headers={"Authorization": "Bearer " + issue_code(api)},
    )
    assert response.status_code == 422, response.text


def test_seat_planner_fills_free_cells_and_grows_canvas():
    positions, height = plan_seat_positions(200, 100, [(40, 40, 40, 40)], 5)
    assert len(positions) == 5 and (40, 40) not in positions
    assert all(x + 40 <= 200 for x, _ in positions)
    assert height >= max(y for _, y in positions) + 40
    assert plan_seat_positions(1000, 700, [], 0) == ([], 700)
