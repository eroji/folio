"""Ldap3Authenticator against a faked ldap3 Connection: no sockets, no network."""

import logging
import ssl
from typing import ClassVar

import pytest
from ldap3 import Server

from folio.config import Settings, get_settings
from folio.ldap_auth import (
    IN_CHAIN_OID,
    InvalidCredentials,
    Ldap3Authenticator,
    NotAllowed,
    bare_username,
    filter_for,
    role_from_groups,
)

USER_DN = "CN=Alice,OU=People,DC=test"
NESTED_GROUP_DN = "CN=Folio-User,DC=test"


class FakeEntry:
    def __init__(self, dn: str, attrs: dict[str, list[bytes]]) -> None:
        self.entry_dn = dn
        self.raw_attributes = attrs

    def __getitem__(self, name: str) -> object:
        return None


class FakeConnection:
    """Records every bind/search; canned results keyed by filter text."""

    def __init__(self, server: Server, user: str = "", password: str = "", **kw: object) -> None:
        self.server = server
        self.user = user
        self.entries: list[FakeEntry] = []
        FakeConnection.connections.append(self)

    connections: ClassVar[list["FakeConnection"]] = []
    searches: ClassVar[list[tuple[str, str]]] = []
    bind_fail_for: ClassVar[dict[str, str]] = {}  # user DN -> reason, bind failures
    search_result_for: ClassVar[dict[str, list[FakeEntry]]] = {}

    def bind(self) -> bool:
        return self.user not in FakeConnection.bind_fail_for

    def search(self, search_base: str, search_filter: str, **kw: object) -> None:
        FakeConnection.searches.append((search_base, search_filter))
        self.entries = []
        for needle, entries in FakeConnection.search_result_for.items():
            if needle in search_filter:
                self.entries = entries

    def unbind(self) -> None:
        pass

    def close(self) -> None:
        pass


@pytest.fixture()
def ldap(monkeypatch: pytest.MonkeyPatch) -> type[FakeConnection]:
    FakeConnection.connections = []
    FakeConnection.searches = []
    FakeConnection.bind_fail_for = {}
    FakeConnection.search_result_for = {}
    monkeypatch.setattr("folio.ldap_auth.Connection", FakeConnection)
    return FakeConnection


@pytest.fixture()
def authenticator() -> Ldap3Authenticator:
    return Ldap3Authenticator(get_settings())


def _user_found(ldap: type[FakeConnection]) -> None:
    ldap.search_result_for["sAMAccountName=alice"] = [
        FakeEntry(USER_DN, {"cn": [b"Alice A"], "mail": [b"alice@test.invalid"]})
    ]


def test_service_bind_then_user_bind_then_nested_group_search(
    authenticator: Ldap3Authenticator, ldap: type[FakeConnection]
) -> None:
    _user_found(ldap)
    ldap.search_result_for[IN_CHAIN_OID] = [FakeEntry(NESTED_GROUP_DN, {"cn": [b"Folio-User"]})]

    user = authenticator.authenticate("alice", "pw")

    assert user.dn == USER_DN
    assert user.username == "alice"
    assert user.display_name == "Alice A"
    assert user.email == "alice@test.invalid"
    assert NESTED_GROUP_DN in user.groups
    # The nested lookup must use the AD in-chain matching rule.
    assert any(IN_CHAIN_OID in f for _, f in ldap.searches)
    # Re-bind happened as the found DN.
    assert any(c.user == USER_DN for c in ldap.connections)


def test_escape_filter_chars_used_in_user_search(
    authenticator: Ldap3Authenticator, ldap: type[FakeConnection]
) -> None:
    _user_found(ldap)
    ldap.search_result_for[IN_CHAIN_OID] = []
    with pytest.raises(InvalidCredentials):
        authenticator.authenticate("al)(ice", "pw")  # no entry matches the escaped filter
    assert any("al\\29\\28ice" in f for _, f in ldap.searches)


def test_unknown_user_is_invalid_credentials(
    authenticator: Ldap3Authenticator, ldap: type[FakeConnection]
) -> None:
    with pytest.raises(InvalidCredentials):
        authenticator.authenticate("nobody", "pw")


def test_user_bind_failure_is_invalid_credentials(
    authenticator: Ldap3Authenticator, ldap: type[FakeConnection]
) -> None:
    _user_found(ldap)
    ldap.bind_fail_for[USER_DN] = "invalid credentials"
    with pytest.raises(InvalidCredentials):
        authenticator.authenticate("alice", "wrong")


def test_no_allowed_group_is_not_allowed(
    authenticator: Ldap3Authenticator, ldap: type[FakeConnection]
) -> None:
    _user_found(ldap)
    ldap.search_result_for[IN_CHAIN_OID] = [FakeEntry("CN=Everyone,DC=test", {})]
    with pytest.raises(NotAllowed):
        authenticator.authenticate("alice", "pw")


def test_nested_group_dn_resolves_role_case_insensitively(
    authenticator: Ldap3Authenticator, ldap: type[FakeConnection]
) -> None:
    ldap.search_result_for["sAMAccountName=alice"] = [
        FakeEntry(USER_DN, {"cn": [b"Alice"], "mail": []})
    ]
    # DN returned by the server in different case than the configured group DN.
    ldap.search_result_for[IN_CHAIN_OID] = [FakeEntry("cn=FOLIO-user,dc=TEST", {})]
    user = authenticator.authenticate("alice", "pw")
    assert role_from_groups(user.groups, get_settings()) == "user"


def test_domain_and_upn_spellings_resolve_to_the_bare_name(
    authenticator: Ldap3Authenticator, ldap: type[FakeConnection]
) -> None:
    _user_found(ldap)
    ldap.search_result_for[IN_CHAIN_OID] = [FakeEntry(NESTED_GROUP_DN, {})]
    user = authenticator.authenticate("CORP\\alice", "pw")
    assert user.username == "alice"
    assert any("sAMAccountName=alice" in f for _, f in ldap.searches)

    ldap.connections = []
    authenticator.authenticate("alice@corp.test", "pw")
    assert any("sAMAccountName=alice" in f for _, f in ldap.searches)


def test_bare_username_spellings() -> None:
    assert bare_username("CORP\\alice") == "alice"
    assert bare_username("alice@corp.test") == "alice"
    assert bare_username("  alice  ") == "alice"


def test_upn_placeholder_uses_the_base_dn(settings: Settings) -> None:
    s = settings.model_copy(
        update={"ldap_user_filter": "(&(objectClass=user)(userPrincipalName={upn}))"}
    )
    assert filter_for("CORP\\alice", s) == "(&(objectClass=user)(userPrincipalName=alice@test))"


def test_canonical_username_comes_from_the_directory(
    authenticator: Ldap3Authenticator, ldap: type[FakeConnection]
) -> None:
    ldap.search_result_for["sAMAccountName=ALICE"] = [
        FakeEntry(USER_DN, {"cn": [b"Alice"], "sAMAccountName": [b"Alice"]})
    ]
    ldap.search_result_for[IN_CHAIN_OID] = [FakeEntry(NESTED_GROUP_DN, {})]
    # Typed in caps; the local users row must key off the directory spelling.
    assert authenticator.authenticate("ALICE", "pw").username == "Alice"


def test_ambiguous_search_results_are_rejected(
    authenticator: Ldap3Authenticator, ldap: type[FakeConnection]
) -> None:
    ldap.search_result_for["sAMAccountName=alice"] = [
        FakeEntry(USER_DN, {}),
        FakeEntry("CN=Other,DC=test", {}),
    ]
    with pytest.raises(InvalidCredentials):
        authenticator.authenticate("alice", "pw")


def test_empty_password_never_attempts_a_bind(
    authenticator: Ldap3Authenticator, ldap: type[FakeConnection]
) -> None:
    with pytest.raises(InvalidCredentials):
        authenticator.authenticate("alice", "")
    assert ldap.connections == []  # no anonymous/unauthenticated bind


def test_admin_group_wins_over_user_group(settings: Settings) -> None:
    groups = [settings.folio_ldap_user_group, settings.folio_ldap_admin_group.upper()]
    assert role_from_groups(groups, settings) == "admin"
    assert role_from_groups(["CN=Random,DC=test"], settings) is None


def test_server_error_maps_to_invalid_credentials_never_leaks(
    authenticator: Ldap3Authenticator,
    ldap: type[FakeConnection],
    caplog: pytest.LogCaptureFixture,
) -> None:
    ldap.bind_fail_for["cn=svc,dc=test"] = "server down"
    with caplog.at_level(logging.WARNING), pytest.raises(InvalidCredentials):
        authenticator.authenticate("alice", "hunter2secret")
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "hunter2secret" not in joined  # never the password
    assert "alice" in joined  # only username + failure class


def test_transport_exception_maps_to_invalid_credentials(
    authenticator: Ldap3Authenticator,
    ldap: type[FakeConnection],
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A DNS/socket failure is a 401, not a 500 (and never logs the password)."""

    def boom(self: FakeConnection) -> bool:
        raise OSError("name resolution failed")

    monkeypatch.setattr(ldap, "bind", boom)
    with caplog.at_level(logging.WARNING), pytest.raises(InvalidCredentials):
        authenticator.authenticate("alice", "hunter2secret")
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "hunter2secret" not in joined
    assert "alice" in joined


def test_ldaps_by_default_with_certificate_validation() -> None:
    s = get_settings().model_copy(update={"ldap_url": "ldaps://ldap.test:636"})
    a = Ldap3Authenticator(s)
    assert a.server.ssl is True
    assert a.server.tls is not None
    assert a.server.tls.validate == ssl.CERT_REQUIRED


def test_plain_ldap_refused_unless_allow_insecure() -> None:
    s = get_settings().model_copy(update={"ldap_url": "ldap://ldap.test:389"})
    with pytest.raises(RuntimeError, match="LDAP_ALLOW_INSECURE"):
        Ldap3Authenticator(s)
    ok = Ldap3Authenticator(s.model_copy(update={"ldap_allow_insecure": True}))
    assert ok.server.ssl is False
