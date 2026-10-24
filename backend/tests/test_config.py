"""Settings: required vars have no defaults, spec defaults apply, TTS_* optional."""

from typing import Any

import pytest
from pydantic import ValidationError

from folio.config import Settings, get_settings

# Every variable from the spec's Configuration table.
ENV_VARS = [
    "FOLIO_BASE_URL",
    "FOLIO_SECRET_KEY",
    "DATABASE_URL",
    "DATA_DIR",
    "MAX_UPLOAD_MB",
    "LDAP_URL",
    "LDAP_BIND_DN",
    "LDAP_BIND_PASSWORD",
    "LDAP_BASE_DN",
    "LDAP_USER_FILTER",
    "FOLIO_LDAP_ADMIN_GROUP",
    "FOLIO_LDAP_USER_GROUP",
    "LDAP_CA_FILE",
    "LDAP_ALLOW_INSECURE",
    "TTS_BASE_URL",
    "TTS_API_KEY",
    "TTS_MODEL",
    "TTS_FORMAT",
    "TTS_DEFAULT_VOICE",
    "TTS_VOICE_MAP",
    "TTS_VOICES",
    "TTS_VOICES_TTL",
    "TTS_VOICE_LANG_PATTERN",
    "TTS_MAX_CHARS",
    "TTS_LOOKAHEAD",
    "TTS_CONCURRENCY",
    "TTS_CHARS_PER_SECOND",
    "AUDIO_CACHE_MAX_GB",
    "METADATA_ONLINE",
    "GOOGLE_BOOKS_API_KEY",
    "FOLIO_TEST_MODE",
]

# No defaults per the spec's Configuration table. TTS_BASE_URL and
# TTS_DEFAULT_VOICE are required in production but optional until M4
# (see docs/DECISIONS.md).
REQUIRED = [
    "FOLIO_BASE_URL",
    "FOLIO_SECRET_KEY",
    "DATABASE_URL",
    "LDAP_URL",
    "LDAP_BIND_DN",
    "LDAP_BIND_PASSWORD",
    "LDAP_BASE_DN",
    "FOLIO_LDAP_ADMIN_GROUP",
    "FOLIO_LDAP_USER_GROUP",
]


@pytest.fixture()
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)


def set_required(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in REQUIRED:
        monkeypatch.setenv(name, f"test-{name.lower()}")


def test_attribute_names_are_lowercased_env_vars(
    clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_required(monkeypatch)
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    for name in ENV_VARS:
        assert hasattr(settings, name.lower()), name


def test_required_vars_have_no_defaults(clean_env: None) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]


@pytest.mark.parametrize("missing", REQUIRED)
def test_each_required_var_fails_start_up(
    clean_env: None, monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    set_required(monkeypatch)
    monkeypatch.delenv(missing)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]


def test_tts_group_is_optional_until_m4(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    set_required(monkeypatch)
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    assert settings.tts_base_url is None
    assert settings.tts_default_voice is None


def test_spec_defaults(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    set_required(monkeypatch)
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    expected: dict[str, Any] = {
        "data_dir": "/data",
        "max_upload_mb": 200,
        "ldap_user_filter": "(&(objectClass=user)(sAMAccountName={username}))",
        "ldap_ca_file": None,
        "ldap_allow_insecure": False,
        "tts_api_key": "",
        "tts_model": "tts",
        "tts_format": "opus",
        "tts_voices": "",
        "tts_voices_ttl": 600,
        "tts_voice_lang_pattern": "-(en|ja|kr|ko|zh)$",
        "tts_max_chars": 800,
        "tts_lookahead": 6,
        "tts_concurrency": 2,
        "tts_chars_per_second": 15.0,
        "audio_cache_max_gb": 50,
        "metadata_online": True,
        "google_books_api_key": "",
        "folio_test_mode": False,
    }
    for attr, value in expected.items():
        actual = getattr(settings, attr)
        assert actual == value or str(actual) == str(value), attr


def test_folio_test_mode_flag(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    set_required(monkeypatch)
    assert Settings(_env_file=None).folio_test_mode is False  # type: ignore[call-arg]
    monkeypatch.setenv("FOLIO_TEST_MODE", "true")
    assert Settings(_env_file=None).folio_test_mode is True  # type: ignore[call-arg]


def test_get_settings_reads_environment(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    set_required(monkeypatch)
    get_settings.cache_clear()
    settings = get_settings()
    assert isinstance(settings, Settings)
    assert settings.folio_base_url == "test-folio_base_url"
    assert get_settings() is settings  # cached
    get_settings.cache_clear()
