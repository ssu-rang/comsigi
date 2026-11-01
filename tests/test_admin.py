import pytest
from sqlalchemy.exc import OperationalError


def test_crud_constraints_and_table_unlink(api, client):
    a, b = api.place(), api.place("other")
    table = api.table(a)
    seat = api.seat(a, table_id=table["id"])
    api.seat(b)  # Same number in another place is legal.
    api.post(f"/places/{a['id']}/seats", {"number": 1}, expected=409)
    api.post(f"/places/{a['id']}/tables", {"number": 1}, expected=409)
    api.post("/places", {"name": "Duplicate", "slug": "library"}, expected=409)
    api.post(f"/places/{b['id']}/seats", {"number": 2, "table_id": table["id"]}, expected=404)
    api.patch(f"/places/{b['id']}/seats/{seat['id']}", {"label": "wrong place"}, expected=404)
    api.patch(f"/places/{a['id']}/tables/{table['id']}", {"x": 100})
    layout = client.get("/api/v1/places/library/layout").json()
    assert layout["seats"][0]["x"] == 0  # Table movement does not move seats.
    api.delete(f"/places/{a['id']}/tables/{table['id']}")
    layout = client.get("/api/v1/places/library/layout").json()
    assert layout["seats"][0]["table_id"] is None
    assert layout["tables"] == []
    assert layout["place"]["created_at"].endswith("Z")


@pytest.mark.parametrize(
    "fields",
    [
        {"number": 0},
        {"number": True},
        {"occupied": True},
        {"width": 0},
        {"x": -1},
        {"rotation": 360},
        {"label": None},
        {"table_id": 0},
    ],
)
def test_invalid_seat_data(api, fields):
    place = api.place()
    api.post(f"/places/{place['id']}/seats", {"number": 1, **fields}, expected=422)


def test_patch_and_canvas_validation(api, client, setup_room):
    place, seat, _ = setup_room
    path = f"/places/{place['id']}/seats/{seat['id']}"
    api.patch(path, {}, expected=422)
    api.patch(path, {"number": None}, expected=422)
    api.patch(path, {"x": 1190}, expected=422)
    api.patch(f"/places/{place['id']}", {"canvas_width": 10}, expected=422)
    assert client.get("/api/v1/places/library/layout").json()["seats"][0]["x"] == 0
    api.patch(path, {"table_id": None})


def test_atomic_layout_and_optimistic_concurrency(api, client, setup_room):
    place, seat, _ = setup_room
    table = api.table(place)
    layout = client.get("/api/v1/places/library/layout").json()
    body = {
        "expected_version": layout["place"]["layout_version"],
        "canvas_width": 1000,
        "canvas_height": 1000,
        "seats": [
            {"id": seat["id"], "x": 200, "y": 300, "width": 40, "height": 40, "rotation": 30}
        ],
        "tables": [
            {"id": table["id"], "x": 100, "y": 100, "width": 120, "height": 80, "rotation": 0}
        ],
    }
    path = f"/api/v1/admin/places/{place['id']}/layout"
    invalid = {**body, "tables": [{**body["tables"][0], "x": 999}]}
    assert client.put(path, json=invalid, headers=api.headers).status_code == 422
    assert client.get("/api/v1/places/library/layout").json() == layout
    invalid = {**body, "seats": []}
    assert client.put(path, json=invalid, headers=api.headers).status_code == 422
    result = client.put(path, json=body, headers=api.headers)
    assert result.status_code == 200, result.text
    assert result.json()["seats"][0]["x"] == 200
    assert result.json()["place"]["layout_version"] == body["expected_version"] + 1
    assert client.put(path, json=body, headers=api.headers).status_code == 409


def test_device_key_rotation_disable_and_move(api, client, setup_room):
    place, _, device = setup_room
    session = api.session(device)
    api.report(device, session, 0, [{"number": 1, "occupied": True}])
    did = device["device"]["id"]
    visible = client.get(f"/api/v1/admin/devices/{did}", headers=api.headers)
    assert visible.json()["status"] == "online"
    assert "credential" not in visible.text
    rotated = api.post(f"/devices/{did}/rotate-credential", {}, expected=200)
    assert api.state(place)["seats"][0]["status"] == "unknown"
    api.report(device, session, 1, [], expected=401)
    api.report(rotated, session, 1, [], expected=409)
    session = api.session(rotated)
    api.report(rotated, session, 0, [{"number": 1, "occupied": False}])
    api.patch(f"/devices/{did}", {"enabled": False})
    api.report(rotated, session, 1, [], expected=401)
    assert api.state(place)["devices"][0]["status"] == "disabled"
    other = api.place("other")
    api.seat(other)
    api.patch(f"/devices/{did}", {"enabled": True, "place_id": other["id"]})
    api.report(rotated, session, 1, [], expected=409)
    session = api.session(rotated)
    api.report(rotated, session, 0, [{"number": 1, "occupied": True}])
    assert api.state(other)["seats"][0]["status"] == "occupied"
    assert api.state(place)["seats"][0]["status"] == "unknown"
    assert api.state(place)["devices"] == []


def test_renumber_invalidates_sessions_and_old_numbers(api, setup_room):
    place, seat, device = setup_room
    session = api.session(device)
    api.report(device, session, 5, [{"number": 1, "occupied": True}])
    api.patch(f"/places/{place['id']}/seats/{seat['id']}", {"number": 2})
    assert api.state(place)["seats"][0]["status"] == "unknown"
    api.report(device, session, 6, [{"number": 1, "occupied": True}], expected=409)
    session = api.session(device)
    api.report(device, session, 0, [{"number": 1, "occupied": True}], expected=422)
    api.report(device, session, 0, [{"number": 2, "occupied": False}])
    assert api.state(place)["seats"][0]["status"] == "available"


def test_place_delete_cascades_and_ids_are_not_reused(api, client, setup_room):
    place, seat, device = setup_room
    api.table(place)
    api.delete(f"/places/{place['id']}")
    assert client.get("/api/v1/places/library/state").status_code == 404
    assert client.get("/api/v1/admin/devices", headers=api.headers).json() == []
    assert not client.app.state.runtime.seats
    assert not client.app.state.runtime.device_sessions
    new_place = api.place()
    new_seat = api.seat(new_place)
    assert new_place["id"] > place["id"]
    assert new_seat["id"] > seat["id"]


def test_legacy_frontend_and_openapi(api, client):
    assert client.get("/api/v1/seats").json() == {"seats": []}
    place = api.place()
    seat = api.seat(place)
    assert client.get("/api/v1/seats").json() == {
        "seats": [{"id": seat["id"], "status": "unknown"}]
    }
    api.place("other")
    assert client.get("/api/v1/seats").status_code == 400
    assert client.get("/api/v1/seats?place_slug=library").status_code == 200
    spec = client.get("/openapi.json").json()
    assert "AdminBearer" in spec["components"]["securitySchemes"]
    assert "DeviceBearer" in spec["components"]["securitySchemes"]
    assert client.get("/api/v1/ready").status_code == 200


def test_database_failure_does_not_commit_or_publish_partial_configuration(
    api, client, setup_room, monkeypatch
):
    place, seat, _ = setup_room
    runtime = client.app.state.runtime

    async def fail_read(_db):
        raise OperationalError("SELECT", {}, Exception("simulated database failure"))

    with client.websocket_connect("/api/v1/places/library/ws") as ws:
        snapshot = ws.receive_json()
        with monkeypatch.context() as patch:
            patch.setattr(runtime, "load_configuration", fail_read)
            api.patch(f"/places/{place['id']}/seats/{seat['id']}", {"x": 200}, expected=503)
        db_seat = client.get(
            f"/api/v1/admin/places/{place['id']}/seats/{seat['id']}", headers=api.headers
        ).json()
        assert db_seat["x"] == 0
        assert api.state(place)["revision"] == snapshot["revision"]
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"
