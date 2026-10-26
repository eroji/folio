"""Description cleanup: strip characters that render as empty boxes."""

import unicodedata


def clean_description(value: str) -> str:
    """Drop invisible/undisplayable characters, keep newlines and tabs.

    NBSP becomes a normal space; U+FFFD and every Unicode category-C
    character (Cc/Cf/Cs/Co/Cn: C0/C1 controls, zero-width characters, BOM,
    surrogates, unassigned) is removed — this is the junk provider and
    embedded metadata bring in.
    """
    value = value.replace("\xa0", " ").replace("\ufffd", "")
    return "".join(c for c in value if c in "\n\t" or unicodedata.category(c)[0] != "C")
