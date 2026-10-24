"""Environment-backed settings, one field per variable in the spec's Configuration table."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # ".env" at the repo root works whether run from backend/ (make, alembic) or the root.
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"), env_file_encoding="utf-8", extra="ignore"
    )

    # Core
    folio_base_url: str
    folio_secret_key: str
    database_url: str
    data_dir: Path = Path("/data")
    max_upload_mb: int = 200
    folio_test_mode: bool = False

    # LDAP
    ldap_url: str
    ldap_bind_dn: str
    ldap_bind_password: str
    ldap_base_dn: str
    ldap_user_filter: str = "(&(objectClass=user)(sAMAccountName={username}))"
    folio_ldap_admin_group: str
    folio_ldap_user_group: str
    ldap_ca_file: str | None = None
    ldap_allow_insecure: bool = False

    # TTS — required in production but optional until M4, validated when the
    # TTS client is first constructed (docs/DECISIONS.md).
    tts_base_url: str | None = None
    tts_api_key: str = ""
    tts_model: str = "tts"
    tts_format: str = "opus"
    tts_default_voice: str | None = None
    tts_voice_map: dict[str, str] = Field(
        default_factory=lambda: {
            "en": "ashley-en",
            "ja": "ashley-ja",
            "ko": "ashley-kr",
            "zh": "ashley-zh",
        }
    )
    tts_voices: str = ""
    tts_voices_ttl: int = 600
    tts_voice_lang_pattern: str = "-(en|ja|kr|ko|zh)$"
    tts_max_chars: int = 800
    tts_lookahead: int = 6
    tts_concurrency: int = 2
    tts_chars_per_second: float = 15.0

    # Audio cache and metadata
    audio_cache_max_gb: int = 50
    metadata_online: bool = True
    google_books_api_key: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
