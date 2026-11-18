"""Admin → Voices "Send style prompts": the stored switch overrides
TTS_INSTRUCTIONS for every synthesis, the listings and voice previews."""

from __future__ import annotations

import httpx
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.tts.narration import engine_instructions, set_style_prompts, style_prompts_on


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def test_the_switch_overrides_the_environment(db: Session, settings: Settings) -> None:
    off_env = settings.model_copy(update={"tts_instructions": False})
    assert style_prompts_on(db, off_env) is False
    assert engine_instructions(db, off_env, "v", "Mystery") == ""
    set_style_prompts(db, True)
    db.commit()
    assert style_prompts_on(db, off_env) is True
    assert "Mystery" in engine_instructions(db, off_env, "v", "Mystery")
    set_style_prompts(db, False)
    db.commit()
    assert engine_instructions(db, settings, "v", "Mystery") == ""  # env says on, switch says off


async def test_admins_flip_it(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    response = await admin_client.put(
        "/api/v1/admin/voices/style-prompts", json={"enabled": False}, headers=csrf(admin_client)
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"style_prompts": False}
    db.expire_all()
    assert style_prompts_on(db, settings) is False  # the test settings' env says on


async def test_users_cannot_flip_it(auth_client: httpx.AsyncClient) -> None:
    response = await auth_client.put(
        "/api/v1/admin/voices/style-prompts", json={"enabled": True}, headers=csrf(auth_client)
    )
    assert response.status_code == 403
