"""One-off live smoke: synthesize a short sentence on the real engine (docs/TTS.md).

Not part of the test suite (the suite never touches the network). Run:
    cd backend && .venv/bin/python scripts/live_tts_smoke.py
"""

from __future__ import annotations

import os
import tempfile

# folio.db builds its engine from the environment at import time.
os.environ.setdefault("FOLIO_BASE_URL", "http://localhost")
os.environ.setdefault("FOLIO_SECRET_KEY", "smoke")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://x:x@localhost/x")
os.environ.setdefault("LDAP_URL", "ldaps://x")
os.environ.setdefault("LDAP_BIND_DN", "x")
os.environ.setdefault("LDAP_BIND_PASSWORD", "x")
os.environ.setdefault("LDAP_BASE_DN", "x")
os.environ.setdefault("FOLIO_LDAP_ADMIN_GROUP", "x")
os.environ.setdefault("FOLIO_LDAP_USER_GROUP", "x")
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="folio-live-smoke-")

import time

import httpx

from folio.config import Settings
from folio.tts import TtsClient
from folio.tts.cache import duration_seconds
from folio.tts.voices import discover_voices

BASE = "http://vllm.dotslash.io:8880/v1"
VOICE = "ashley-en"
TEXT = "Folio can now speak this sentence out loud."


def main() -> None:
    settings = Settings()
    settings = settings.model_copy(
        update={"tts_base_url": BASE, "tts_model": "tts", "tts_format": "opus"}
    )
    with TtsClient(settings) as client:
        voices = discover_voices(settings, client)
        print("voices:", [(v.id, v.language) for v in voices])
        health = httpx.get(BASE.removesuffix("/v1") + "/health", timeout=2.0)
        print(f"health: {health.status_code} {health.text}")
        started = time.monotonic()
        data, fmt = client.synthesize(TEXT, VOICE)
        elapsed = time.monotonic() - started
    path = settings.data_dir / f"live-smoke.{fmt}"
    path.write_bytes(data)
    print(
        f"synthesized {len(data)} bytes as {fmt} in {elapsed:.2f}s, "
        f"duration {duration_seconds(path):.2f}s"
    )


if __name__ == "__main__":
    main()
