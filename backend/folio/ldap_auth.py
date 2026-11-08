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

# Must stay ints: ldap3 2.9 on Python 3.12 passes these straight to
# socket.settimeout, and a float makes Connection.bind() raise
# struct.error ("required argument is not an integer") -> HTTP 500 on login.
LDAP_CONNECT_TIMEOUT_S = 10
LDAP_RECEIVE_TIMEOUT_S = 10


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
            # Skip the RootDSE schema fetch: a measurable latency win per bind.
            get_info=None,
        )

    def _connection(self, user: str, password: str) -> Connection:
        return Connection(
            self.server,
            user=user,
            password=password,
            receive_timeout=LDAP_RECEIVE_TIMEOUT_S,
            # Never chase AD referrals to another forest during a login.
            auto_referrals=False,
        )

    def authenticate(self, username: str, password: str) -> LdapUser:
        s = self._settings
        # An empty password must never become an unauthenticated bind.
        if not password:
            raise InvalidCredentials
        try:
            service = self._connection(s.ldap_bind_dn, s.ldap_bind_password)
            try:
                if not service.bind():
                    logger.warning("ldap login failed user=%s reason=service_bind", username)
                    raise InvalidCredentials
                svc_filter = filter_for(username, s)
                service.search(
                    s.ldap_base_dn,
                    svc_filter,
                    search_scope=SUBTREE,
                    attributes=["cn", "mail", "sAMAccountName", "uid", "memberOf"],
                )
                # Exactly one entry: zero (unknown) and many (ambiguous) both
                # mean "these credentials do not identify one account".
                if len(service.entries) != 1:
                    logger.info(
                        "ldap login failed user=%s reason=entries_%d",
                        username,
                        len(service.entries),
                    )
                    raise InvalidCredentials
                entry = service.entries[0]
                user_dn: str = entry.entry_dn
                groups = _values(entry, "memberOf")

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
        # Canonical spelling from the directory, so `ALICE`, `DOMAIN\alice`
        # and `alice@corp` all resolve to the one local users row.
        canonical = _attr(entry, "sAMAccountName") or _attr(entry, "uid") or bare_username(username)
        return LdapUser(
            dn=user_dn,
            username=canonical,
            display_name=_attr(entry, "cn") or canonical,
            email=_attr(entry, "mail"),
            groups=groups,
        )


def bare_username(typed: str) -> str:
    """`CORP\\alice`, `alice@corp.example` and `alice` all mean `alice`."""
    name = (typed or "").strip()
    if "\\" in name:
        name = name.rsplit("\\", 1)[1]
    if "/" in name:
        name = name.rsplit("/", 1)[1]
    if "@" in name:
        name = name.split("@", 1)[0]
    return name


def upn_suffix(base_dn: str) -> str:
    """`@corp.example` derived from the `dc=` parts of the base DN."""
    domains = [
        part.split("=", 1)[1]
        for part in base_dn.split(",")
        if part.strip().lower().startswith("dc=") and "=" in part
    ]
    return "@" + ".".join(domains) if domains else ""


def filter_for(username: str, settings: Settings) -> str:
    """Build the user search filter, supporting both `{username}` and `{upn}`."""
    bare = bare_username(username)
    upn = f"{bare}{upn_suffix(settings.ldap_base_dn)}"
    return settings.ldap_user_filter.replace("{username}", escape_filter_chars(bare)).replace(
        "{upn}", escape_filter_chars(upn)
    )


def _values(entry: object, name: str) -> list[str]:
    """The entry's values for ``name`` (ldap3 2.9: entry_attributes_as_dict).

    Keys come back in the server's own casing, so compare case-insensitively.
    """
    attrs = getattr(entry, "entry_attributes_as_dict", None) or {}
    for key, values in attrs.items():
        if str(key).lower() == name.lower():
            return [str(v) for v in (values or [])]
    return []


def _attr(entry: object, name: str) -> str:
    values = _values(entry, name)
    return values[0] if values else ""
