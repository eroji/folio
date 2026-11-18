"""Admin → Metadata and AI: masked keys, keep/clear semantics, and the Test buttons."""

from __future__ import annotations

import io

import httpx
import pymupdf  # type: ignore[import-untyped]
import pytest
from mock_llm import completion, has_image, serve
from sqlalchemy.orm import Session

from folio.integrations import Integrations, LanguageModel, load_integrations, save_integrations
from folio.metadata import googlebooks
from folio.routers.integrations import SAMPLE_TEXT

URL = "/api/v1/admin/integrations"


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


async def test_keys_are_masked_and_kept_unless_given(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    body = {
        "google_books_api_key": "AIzaSy-google-key-9876",
        "language_model": {
            "base_url": "http://llm.local/v1",
            "model": "qwen",
            "api_key": "sk-abcdef-1234",
        },
    }
    response = await admin_client.put(URL, json=body, headers=csrf(admin_client))
    assert response.status_code == 200, response.text
    shown = response.json()
    assert shown["google_books"] == {"key_set": True, "key_hint": "…9876", "env_key": False}
    assert shown["language_model"]["key_hint"] == "…1234"
    assert "sk-abcdef" not in response.text and "AIzaSy" not in response.text

    # Leaving a key out keeps it; other fields change.
    response = await admin_client.put(
        URL, json={"language_model": {"model": "qwen-vl", "ocr": True}}, headers=csrf(admin_client)
    )
    saved = load_integrations(db)
    assert saved.language_model.api_key == "sk-abcdef-1234"
    assert saved.language_model.model == "qwen-vl" and saved.language_model.ocr
    assert saved.google_books_api_key == "AIzaSy-google-key-9876"

    # An explicit empty / null removes it.
    await admin_client.put(
        URL,
        json={"google_books_api_key": "", "language_model": {"api_key": None}},
        headers=csrf(admin_client),
    )
    db.expire_all()
    saved = load_integrations(db)
    assert saved.google_books_api_key == "" and saved.language_model.api_key == ""
    assert (await admin_client.get(URL)).json()["google_books"]["key_set"] is False


async def test_features_need_an_endpoint_and_model(admin_client: httpx.AsyncClient) -> None:
    response = await admin_client.put(
        URL, json={"language_model": {"ocr": True}}, headers=csrf(admin_client)
    )
    assert response.status_code == 422
    response = await admin_client.put(
        URL,
        json={"language_model": {"base_url": "llm.local/v1", "model": "m"}},
        headers=csrf(admin_client),
    )
    assert response.status_code == 422  # no scheme


async def test_admins_only(auth_client: httpx.AsyncClient) -> None:
    assert (await auth_client.get(URL)).status_code == 403


async def test_google_test_uses_the_draft_or_saved_key(
    admin_client: httpx.AsyncClient, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[str] = []

    def probe(client: httpx.Client, key: str) -> tuple[bool, str]:
        seen.append(key)
        return True, "Google Books answered with this key."

    monkeypatch.setattr(googlebooks, "probe", probe)
    save_integrations(db, Integrations(google_books_api_key="saved-key"))
    db.commit()
    assert (
        await admin_client.post(f"{URL}/google-books/test", json={}, headers=csrf(admin_client))
    ).json() == {
        "ok": True,
        "message": "Google Books answered with this key.",
    }
    await admin_client.post(
        f"{URL}/google-books/test", json={"api_key": "draft"}, headers=csrf(admin_client)
    )
    assert seen == ["saved-key", "draft"]


async def test_language_model_test_tries_the_draft_with_the_saved_key(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    save_integrations(
        db, Integrations(language_model=LanguageModel(api_key="sk-saved", model="old"))
    )
    db.commit()
    with serve(lambda body: completion("ready", model=body["model"])) as (url, requests):
        response = await admin_client.post(
            f"{URL}/language-model/test",
            json={"base_url": url, "model": "draft-model"},
            headers=csrf(admin_client),
        )
    result = response.json()
    assert result["ok"] is True and result["reply"] == "ready"
    assert result["message"].startswith("draft-model answered in ")
    assert requests[0]["_auth"] == "Bearer sk-saved"
    # Testing never saves.
    db.expire_all()
    assert load_integrations(db).language_model.model == "old"


async def test_language_model_test_reports_failure(admin_client: httpx.AsyncClient) -> None:
    with serve(lambda body: (401, {"error": {"message": "bad key"}})) as (url, _):
        response = await admin_client.post(
            f"{URL}/language-model/test",
            json={"base_url": url, "model": "m"},
            headers=csrf(admin_client),
        )
    assert response.json() == {
        "ok": False,
        "message": "The language model refused the API key (HTTP 401).",
    }


async def test_ocr_test_reads_the_sample_page_with_the_reading_model(
    admin_client: httpx.AsyncClient,
) -> None:
    with serve(lambda body: completion(SAMPLE_TEXT)) as (url, requests):
        response = await admin_client.post(
            f"{URL}/language-model/test-ocr",
            data={"base_url": url, "model": "chat", "ocr_model": "vision"},
            headers=csrf(admin_client),
        )
    result = response.json()
    assert result["ok"] is True and result["text"] == SAMPLE_TEXT == result["expected"]
    assert requests[0]["model"] == "vision" and has_image(requests[0])


async def test_ocr_test_reads_an_uploaded_image_or_pdf(admin_client: httpx.AsyncClient) -> None:
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "Chapter One")
    pdf = doc.tobytes()
    with serve(lambda body: completion("Chapter One")) as (url, requests):
        for name, data in (("page.pdf", pdf), ("page.png", b"\x89PNG\r\n\x1a\nrest")):
            response = await admin_client.post(
                f"{URL}/language-model/test-ocr",
                data={"base_url": url, "model": "m"},
                files={"file": (name, io.BytesIO(data))},
                headers=csrf(admin_client),
            )
            assert response.json()["text"] == "Chapter One", response.text
            assert response.json()["expected"] is None
        images = [r["messages"][0]["content"][1]["image_url"]["url"] for r in requests]
    assert images[0].startswith("data:image/jpeg;base64,")  # the PDF's first page, rendered
    assert images[1].startswith("data:image/png;base64,")
    response = await admin_client.post(
        f"{URL}/language-model/test-ocr",
        data={"base_url": "http://127.0.0.1:9/v1", "model": "m"},
        files={"file": ("notes.txt", io.BytesIO(b"plain text"))},
        headers=csrf(admin_client),
    )
    assert response.status_code == 422


async def test_models_are_listed_from_the_draft_base_url(admin_client: httpx.AsyncClient) -> None:
    with serve(lambda body: completion("x"), models=["utility", "uncensored"]) as (url, _):
        response = await admin_client.post(
            f"{URL}/language-model/models", json={"base_url": url}, headers=csrf(admin_client)
        )
    assert response.json() == {"ok": True, "models": ["uncensored", "utility"]}
    response = await admin_client.post(
        f"{URL}/language-model/models",
        json={"base_url": "http://127.0.0.1:9/v1"},
        headers=csrf(admin_client),
    )
    assert response.json()["ok"] is False and response.json()["models"] == []


async def test_thinking_is_off_unless_switched_on_and_a_test_says_when_it_happened_anyway(
    admin_client: httpx.AsyncClient,
) -> None:
    assert (await admin_client.get(URL)).json()["language_model"]["thinking"] is False

    def thinks_anyway(body: dict) -> tuple[int, dict]:
        status, payload = completion("ready", model="uncensored")
        payload["usage"] = {"completion_tokens_details": {"reasoning_tokens": 22}}
        return status, payload

    with serve(thinks_anyway) as (url, requests):
        result = (
            await admin_client.post(
                f"{URL}/language-model/test",
                json={"base_url": url, "model": "uncensored"},
                headers=csrf(admin_client),
            )
        ).json()
    assert requests[0]["chat_template_kwargs"] == {"enable_thinking": False}
    assert result["ok"] is True and result["reasoning_tokens"] == 22
    assert "ignores the request not to think" in result["message"]

    response = await admin_client.put(
        URL,
        json={"language_model": {"base_url": "http://x/v1", "model": "m", "thinking": True}},
        headers=csrf(admin_client),
    )
    assert response.json()["language_model"]["thinking"] is True
