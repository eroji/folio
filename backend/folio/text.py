"""Description cleanup: plain text from book/provider HTML, minus the
characters that render as empty boxes."""

import html
import re
import unicodedata

import bleach  # type: ignore[import-untyped]

_LINE_BREAK = re.compile(r"<br\s*/?>", re.IGNORECASE)
_BLOCK_END = re.compile(r"</(?:p|div|li|h[1-6]|blockquote)\s*>", re.IGNORECASE)
_EXTRA_BLANK_LINES = re.compile(r"[ \t]*\n[ \t]*\n\s*")
# Each pass strips one layer of markup and decodes one layer of entities;
# OPFs that escape their HTML twice need the second pass.
_MAX_PASSES = 3


def clean_description(value: str) -> str:
    """Drop invisible/undisplayable characters, keep newlines and tabs.

    NBSP becomes a normal space; U+FFFD and every Unicode category-C
    character (Cc/Cf/Cs/Co/Cn: C0/C1 controls, zero-width characters, BOM,
    surrogates, unassigned) is removed — this is the junk provider and
    embedded metadata bring in.
    """
    value = value.replace("\xa0", " ").replace("�", "")
    return "".join(c for c in value if c in "\n\t" or unicodedata.category(c)[0] != "C")


def decode_entities(value: str) -> str:
    """Plain text that still holds HTML entities (``&ldquo;``) -> characters.

    Cheap enough for every book payload: rows stored before descriptions were
    decoded on write keep their entities, so the read path decodes them too.
    """
    return clean_description(html.unescape(value)) if "&" in value else clean_description(value)


def description_text(raw: str) -> str:
    """HTML (or plain text) description -> the plain text Folio stores.

    Markup is stripped with bleach and entities are decoded — bleach alone
    returns *escaped* text, which React then shows as a literal ``&ldquo;``.
    ``<br>`` and closing block tags become line breaks so paragraphs do not
    run together (the UI renders with ``white-space: pre-line``).
    """
    text = raw
    for _ in range(_MAX_PASSES):
        marked = _BLOCK_END.sub("\n\n", _LINE_BREAK.sub("\n", text))
        stripped = html.unescape(bleach.clean(marked, tags=[], strip=True))
        if stripped == text:
            break
        text = stripped
    text = _EXTRA_BLANK_LINES.sub("\n\n", clean_description(text))
    return text.strip()
