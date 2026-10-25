"""apply_rules: flag combinations, creation order, single pass per rule."""

from __future__ import annotations

from folio.models.book import PronunciationRule
from folio.tts.pronunciation import apply_rules


def _rule(
    match: str,
    say: str,
    *,
    whole_word: bool = False,
    after_number: bool = False,
    case_sensitive: bool = False,
) -> PronunciationRule:
    # Un-flushed: apply_rules only reads the fields.
    return PronunciationRule(
        match=match,
        say=say,
        whole_word=whole_word,
        after_number=after_number,
        case_sensitive=case_sensitive,
    )


def test_default_rule_is_case_insensitive_substring() -> None:
    rules = [_rule("nginx", "engine X")]
    assert apply_rules("Nginx reloads nginx.", rules) == "engine X reloads engine X."


def test_case_sensitive_only_matches_the_exact_case() -> None:
    rules = [_rule("nginx", "engine X", case_sensitive=True)]
    assert apply_rules("Nginx and nginx", rules) == "Nginx and engine X"


def test_whole_word_leaves_longer_words_alone() -> None:
    rules = [_rule("nginx", "engine X", whole_word=True)]
    assert apply_rules("nginxx and nginx.", rules) == "nginxx and engine X."


def test_after_number_requires_a_digit_before() -> None:
    rules = [_rule("nginx", "engine X", after_number=True)]
    assert apply_rules("the nginx, 1 nginx, 7nginx", rules) == "the nginx, 1 engine X, 7engine X"


def test_after_number_and_whole_word_combine() -> None:
    rules = [_rule("nginx", "engine X", whole_word=True, after_number=True)]
    assert apply_rules("1 nginxx 2 nginx", rules) == "1 nginxx 2 engine X"


def test_after_number_and_case_sensitive_combine() -> None:
    rules = [_rule("NGINX", "engine X", after_number=True, case_sensitive=True)]
    assert apply_rules("1 NGINX 2 nginx", rules) == "1 engine X 2 nginx"


def test_rules_apply_in_creation_order() -> None:
    rules = [_rule("a", "b"), _rule("b", "c")]
    # Sequential application: rule 2 sees what rule 1 produced.
    assert apply_rules("a", rules) == "c"


def test_replacement_is_never_rematched_by_its_own_rule() -> None:
    rules = [_rule("a", "aa")]
    assert apply_rules("a a", rules) == "aa aa"  # one pass, not a loop


def test_regex_metacharacters_in_match_are_literal() -> None:
    rules = [_rule("c++", "see plus plus")]
    assert apply_rules("C++ and c++", rules) == "see plus plus and see plus plus"


def test_backslashes_in_say_are_literal() -> None:
    assert apply_rules("a", [_rule("a", "x\\y")]) == "x\\y"


def test_empty_rule_list_is_the_identity() -> None:
    assert apply_rules("unchanged", []) == "unchanged"
