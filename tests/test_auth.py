import asyncio

from conftest import PASSWORD

from app.cli import save_admin
from app.security import token_hash


def test_admin_authentication_logout_expiry_and_role_separation(api, client, setup_room):
    _, _, device = setup_room
    assert client.post("/api/v1/admin/places", json={"name": "x", "slug": "x"}).status_code == 401
    assert client.get("/api/v1/admin/places", headers=api.device_headers(device)).status_code == 401
    assert (
        client.post(
            "/api/v1/hardware/session", headers=api.headers, json={"device_uid": "camera-1"}
        ).status_code
        == 401
    )
    assert client.get("/api/v1/auth/me", headers=api.headers).json()["username"] == "admin"
    token = api.headers["Authorization"].split()[1]
    client.app.state.auth.sessions[token_hash(token)].expires = 0
    assert client.get("/api/v1/auth/me", headers=api.headers).status_code == 401
    response = client.post("/api/v1/auth/token", json={"username": "admin", "password": PASSWORD})
    headers = {"Authorization": "Bearer " + response.json()["access_token"]}
    assert response.headers["cache-control"] == "no-store"
    assert client.delete("/api/v1/auth/token", headers=headers).status_code == 204
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 401


def test_password_change_revokes_sessions(api, client, settings):
    asyncio.run(save_admin(settings, "admin", "new-integration-password", reset=True))
    assert client.get("/api/v1/auth/me", headers=api.headers).status_code == 401
    assert (
        client.post(
            "/api/v1/auth/token", json={"username": "admin", "password": PASSWORD}
        ).status_code
        == 401
    )


def test_login_rate_limit_and_validation_redaction(client):
    for _ in range(10):
        result = client.post("/api/v1/auth/token", json={"username": "nobody", "password": "wrong"})
        assert result.status_code == 401
    result = client.post("/api/v1/auth/token", json={"username": "nobody", "password": "wrong"})
    assert result.status_code == 429
    assert result.headers["retry-after"] == "60"
    result = client.post(
        "/api/v1/auth/token", json={"username": "admin", "password": {"secret": "do-not-echo"}}
    )
    assert result.status_code == 422
    assert "do-not-echo" not in result.text


def test_cors_and_disabled_unknown_device(api, client, setup_room):
    _, _, device = setup_room
    preflight = client.options(
        "/api/v1/admin/places",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization,Content-Type",
        },
    )
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "http://localhost:5173"
    blocked = client.options(
        "/api/v1/places",
        headers={
            "Origin": "https://untrusted.example",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert "access-control-allow-origin" not in blocked.headers
    result = client.post(
        "/api/v1/hardware/session", json={"device_uid": "wrong"}, headers=api.device_headers(device)
    )
    assert result.status_code == 401
