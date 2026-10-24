"""LDAP (Active Directory) authentication via ldap3.

Flow (spec "Login flow"): service bind -> search for the user -> re-bind as
the found DN -> read memberOf including nested groups via
LDAP_MATCHING_RULE_IN_CHAIN -> map group DNs to a role. Never log passwords
or bind responses; log only the username and a failure class.
"""

from __future__ import annotations

import contextlib
import logging
import ssl
from typing import NamedTuple, Protocol

from ldap3 import SUBTREE, Connection, Server, Tls  # type: ignore[import-untyped]
from ldap3.core.exceptions import LDAPException  # type: ignore[import-untyped]
from ldap3.utils.conv import escape_filter_chars  # type: ignore[import-untyped]

from folio.config import Settings

logger = logging.getLogger(__name__)

# Active Directory matching rule for transitive (nested) group membership.
IN_CHAIN_OID = "1.2.840.113556.1.4.1941"

LDAP_CONNECT_TIMEOUT_S = 10.0
LDAP_RECEIVE_TIMEOUT_S = 10.0


class InvalidCredentials(Exception):
    """Unknown user or bad password; the API maps this to a generic 401."""


class NotAllowed(Exception):
    """Authenticated, but in neither allowed directory group."""


class LdapUser(NamedTuple):
    dn: str
    username: str
    display_name: str
    email: str
    groups: list[str]


class LdapAuthenticator(Protocol):
    def authenticate(self, username: str, password: str) -> LdapUser: ...


def role_from_groups(groups: list[str], settings: Settings) -> str | None:
    """Map group DNs to a role, case-insensitively; admin wins ties."""
    normalized = {g.strip().lower() for g in groups}
    if settings.folio_ldap_admin_group.strip().lower() in normalized:
        return "admin"
    if settings.folio_ldap_user_group.strip().lower() in normalized:
        return "user"
    return None


class Ldap3Authenticator:
    """LdapAuthenticator backed by the ldap3 SYNC strategy."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        use_ssl = settings.ldap_url.startswith("ldaps")
        if not use_ssl and not settings.ldap_allow_insecure:
            raise RuntimeError(
                "plain LDAP requires LDAP_ALLOW_INSECURE=true; use ldaps:// "
                "(spec: Sessions and security)"
            )
        tls: Tls | None = None
        if use_ssl:
            tls = Tls(ca_certs_file=settings.ldap_ca_file, validate=ssl.CERT_REQUIRED)
        self.server = Server(
            settings.ldap_url,
            use_ssl=use_ssl,
            tls=tls,
            connect_timeout=LDAP_CONNECT_TIMEOUT_S,
        )

    def _connection(self, user: str, password: str) -> Connection:
        return Connection(
            self.server,
            user=user,
            password=password,
            receive_timeout=LDAP_RECEIVE_TIMEOUT_S,
        )

    def authenticate(self, username: str, password: str) -> LdapUser:
        s = self._settings
        try:
            service = self._connection(s.ldap_bind_dn, s.ldap_bind_password)
            try:
                if not service.bind():
                    logger.warning("ldap login failed user=%s reason=service_bind", username)
                    raise InvalidCredentials
                svc_filter = s.ldap_user_filter.format(username=escape_filter_chars(username))
                service.search(
                    s.ldap_base_dn,
                    svc_filter,
                    search_scope=SUBTREE,
                    attributes=["cn", "mail", "memberOf"],
                )
                if not service.entries:
                    logger.info("ldap login failed user=%s reason=no_such_user", username)
                    raise InvalidCredentials
                entry = service.entries[0]
                user_dn: str = entry.entry_dn
                groups = [
                    v.decode("utf-8", "replace") for v in entry.raw_attributes.get("memberOf", [])
                ]

                as_user = self._connection(user_dn, password)
                if not as_user.bind():
                    logger.info("ldap login failed user=%s reason=bad_password", username)
                    raise InvalidCredentials
                chain_filter = (
                    f"(&(objectClass=group)(member:{IN_CHAIN_OID}:={escape_filter_chars(user_dn)}))"
                )
                as_user.search(
                    s.ldap_base_dn, chain_filter, search_scope=SUBTREE, attributes=["dn"]
                )
                groups += [g.entry_dn for g in as_user.entries]
            finally:
                # ldap3 exposes unbind(), not close(); teardown must never mask
                # the authentication result.
                with contextlib.suppress(Exception):
                    service.unbind()
        except (LDAPException, OSError) as exc:
            # Transport/protocol failures must not reveal which LDAP step broke.
            logger.warning("ldap login failed user=%s reason=ldap_error", username)
            logger.debug("ldap error class: %s", type(exc).__name__)
            raise InvalidCredentials from exc
        if role_from_groups(groups, s) is None:
            logger.info("ldap login refused user=%s reason=not_allowed", username)
            raise NotAllowed
        return LdapUser(
            dn=user_dn,
            username=username,
            display_name=_attr(entry, "cn"),
            email=_attr(entry, "mail"),
            groups=groups,
        )


def _attr(entry: object, name: str) -> str:
    raw: dict[str, list[bytes]] = getattr(entry, "raw_attributes", {})
    values = raw.get(name) or []
    return values[0].decode("utf-8", "replace") if values else ""
