"""The language model suggests pronunciation rules and a delivery note; a
suggestion changes nothing about the audio until it is accepted."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from mock_llm import completion, prompt_text, serve
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio import worker
from folio.config import Settings
from folio.integrations import Integrations, LanguageModel, save_integrations
from folio.llm import LlmError
from folio.models import Book, Chapter, Job, PronunciationRule, Segment
from folio.suggest import suggest_for_book
from folio.tts.narration import narration_prompt
from folio.tts.queue import _rules

TEXT = (
    "Siobhan walked to Dún Laoghaire before dawn. The ferry was late. "
    "Later Siobhan met Aoife at the pier, and Aoife laughed at the gulls. "
)


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def _book(db: Session) -> Book:
    book = Book(
        title="The Pier",
        authors=["A. Writer"],
        language="en",
        status="ready",
        genre="Literary fiction",
    )
    db.add(book)
    db.flush()
    chapter = Chapter(book_id=book.id, idx=0, title="One", char_count=len(TEXT))
    db.add(chapter)
    db.flush()
    db.add(Segment(chapter_id=chapter.id, idx=0, text=TEXT, char_start=0, char_end=len(TEXT)))
    db.commit()
    return book


def _model(db: Session, url: str) -> None:
    save_integrations(db, Integrations(language_model=LanguageModel(base_url=url, model="m")))
    db.commit()


ANSWER = {
    "delivery_note": "Quiet, coastal and unhurried; let the dialogue stay warm and wry.",
    "rules": [
        {"match": "Siobhan", "say": "Shiv-awn", "whole_word": True},
        {"match": "Aoife", "say": "Ee-fa"},
        {"match": "Gandalf", "say": "Gan-dalf"},  # not in this book: dropped
        {"match": "Dún Laoghaire", "say": "Dun Leery", "whole_word": True},
        {"match": "ferry", "say": "ferry"},  # same as written: dropped
    ],
}


def _answer(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    return completion("Here you go:\n```json\n" + json.dumps(ANSWER) + "\n```")


def test_suggestions_land_as_suggested_rules_and_a_note(db: Session, settings: Settings) -> None:
    book = _book(db)
    db.add(PronunciationRule(book_id=book.id, match="aoife", say="Eefa"))  # the owner's own rule
    db.commit()
    with serve(_answer) as (url, requests):
        _model(db, url)
        suggest_for_book(db, settings, book.id)
    prompt = prompt_text(requests[0])
    assert "Title: The Pier" in prompt and "Siobhan" in prompt and "Excerpt:" in prompt
    rules = db.scalars(select(PronunciationRule).where(PronunciationRule.suggested.is_(True))).all()
    assert {(r.match, r.say, r.whole_word) for r in rules} == {
        ("Siobhan", "Shiv-awn", True),
        ("Dún Laoghaire", "Dun Leery", True),
    }
    db.refresh(book)
    assert book.delivery_note == ANSWER["delivery_note"]
    # Speech uses only the owner's accepted rule.
    assert [r.match for r in _rules(db, book.id)] == ["aoife"]


def test_a_rerun_replaces_suggestions_and_never_overwrites_a_hand_written_note(
    db: Session, settings: Settings
) -> None:
    book = _book(db)
    book.delivery_note = "My own note."
    book.locked_fields = ["delivery_note"]
    db.commit()
    with serve(_answer) as (url, _):
        _model(db, url)
        suggest_for_book(db, settings, book.id)
        suggest_for_book(db, settings, book.id)
    assert db.query(PronunciationRule).count() == 3  # replaced, not 6
    db.refresh(book)
    assert book.delivery_note == "My own note."


def test_a_bad_answer_fails_the_job(db: Session, settings: Settings) -> None:
    book = _book(db)
    with serve(lambda body: completion("I cannot help with that.")) as (url, _):
        _model(db, url)
        with pytest.raises(LlmError):
            suggest_for_book(db, settings, book.id)


def test_suggest_is_a_worker_job() -> None:
    assert worker.HANDLERS["suggest"] is suggest_for_book


def test_the_delivery_note_follows_the_voice_style_instead_of_the_genre(db: Session) -> None:
    from folio.tts.narration import DEFAULT_INSTRUCTION

    assert (
        narration_prompt(db, "v", "Mystery", "Hushed and tense")
        == DEFAULT_INSTRUCTION + " Hushed and tense."
    )
    assert (
        narration_prompt(db, "v", "Mystery", "  ")
        == DEFAULT_INSTRUCTION + " You're narrating a Mystery novel."
    )


# --- API -------------------------------------------------------------------


async def test_listing_shows_suggestions_and_what_the_model_can_do(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db)
    db.add(PronunciationRule(book_id=book.id, match="Siobhan", say="Shiv-awn", suggested=True))
    db.commit()
    url = f"/api/v1/books/{book.id}/pronunciation"
    body = (await admin_client.get(url)).json()
    assert body["items"][0]["suggested"] is True
    assert body["can_suggest"] is False and body["suggesting"] is False
    assert body["style_prompts"] is True  # the test settings' default

    response = await admin_client.post(f"{url}/suggest", headers=csrf(admin_client))
    assert response.status_code == 409
    assert "Admin → Integrations" in response.json()["error"]["message"]

    _model(db, "http://llm.local/v1")
    response = await admin_client.post(f"{url}/suggest", headers=csrf(admin_client))
    assert response.status_code == 202
    again = await admin_client.post(f"{url}/suggest", headers=csrf(admin_client))
    assert again.json()["job_id"] == response.json()["job_id"]  # one job at a time
    body = (await admin_client.get(url)).json()
    assert body["can_suggest"] is True and body["suggesting"] is True
    assert db.query(Job).filter(Job.type == "suggest").count() == 1


async def test_accepting_changes_the_audio_and_dismissing_does_not(
    admin_client: httpx.AsyncClient, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    book = _book(db)
    keep = PronunciationRule(book_id=book.id, match="Siobhan", say="Shiv-awn", suggested=True)
    drop = PronunciationRule(book_id=book.id, match="Aoife", say="Ee-fa", suggested=True)
    db.add_all([keep, drop])
    db.commit()
    dropped: list[object] = []
    monkeypatch.setattr(
        "folio.routers.pronunciation.invalidate_book_audio",
        lambda db, book_id: dropped.append(book_id),
    )
    url = f"/api/v1/books/{book.id}/pronunciation"

    edited = await admin_client.patch(
        f"{url}/{keep.id}", json={"say": "Shi-vawn"}, headers=csrf(admin_client)
    )
    assert edited.json()["rule"]["suggested"] is True and dropped == []
    response = await admin_client.delete(f"{url}/{drop.id}", headers=csrf(admin_client))
    assert response.status_code == 204 and dropped == []

    accepted = await admin_client.patch(
        f"{url}/{keep.id}", json={"suggested": False}, headers=csrf(admin_client)
    )
    assert accepted.json()["rule"]["suggested"] is False
    assert dropped == [book.id]


async def test_a_hand_made_rule_replaces_a_suggestion_for_the_same_word(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db)
    db.add(PronunciationRule(book_id=book.id, match="Siobhan", say="Shiv-awn", suggested=True))
    db.commit()
    response = await admin_client.post(
        f"/api/v1/books/{book.id}/pronunciation",
        json={"match": "siobhan", "say": "Sha-vonne"},
        headers=csrf(admin_client),
    )
    assert response.status_code == 200, response.text
    rules = db.scalars(select(PronunciationRule).where(PronunciationRule.book_id == book.id)).all()
    assert [(r.say, r.suggested) for r in rules] == [("Sha-vonne", False)]


async def test_the_delivery_note_is_editable_and_locks(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db)
    response = await admin_client.patch(
        f"/api/v1/books/{book.id}",
        json={"delivery_note": "  Brisk and bright.  "},
        headers=csrf(admin_client),
    )
    assert response.status_code == 200, response.text
    assert response.json()["book"]["delivery_note"] == "Brisk and bright."
    assert "delivery_note" in response.json()["book"]["locked_fields"]
