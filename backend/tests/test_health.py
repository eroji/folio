"""Health endpoints: /healthz is open, /api/v1/admin/health requires a session."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from folio.config import get_settings

# Minimal environment so Settings validation passes; no DB connection is made
# by these tests (create_engine is lazy about connecting).
REQUIRED_ENV = {
    "FOLIO_BASE_URL": "http://testserver",
    "FOLIO_SECRET_KEY": "test-secret",
    "DATABASE_URL": "postgresql+psycopg://folio:folio@localhost:5432/folio_test",
    "LDAP_URL": "ldaps://ldap.test:636",
    "LDAP_BIND_DN": "cn=svc,dc=test",
    "LDAP_BIND_PASSWORD": "svc-password",
    "LDAP_BASE_DN": "dc=test",
    "FOLIO_LDAP_ADMIN_GROUP": "cn=folio-admin,dc=test",
    "FOLIO_LDAP_USER_GROUP": "cn=folio-user,dc=test",
}


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    for name, value in REQUIRED_ENV.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    from folio.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client
    get_settings.cache_clear()


def test_healthz_ok_without_auth(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_admin_health_requires_session(client: TestClient) -> None:
    response = client.get("/api/v1/admin/health")
    assert response.status_code == 401
    body = response.json()
    assert body["error"]["code"] == "unauthenticated"
    assert isinstance(body["error"]["message"], str)
