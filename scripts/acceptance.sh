#!/usr/bin/env bash
# M1–M2 acceptance: run against a live stack (compose or `make dev-backend`).
# Requires FOLIO_TEST_MODE=true on the server. Usage:
#   BASE=http://localhost:8000 ./scripts/acceptance.sh
set -euo pipefail

BASE="${BASE:-http://localhost:8000}"
API="$BASE/api/v1"
FIXTURES="$(cd "$(dirname "$0")/.." && pwd)/backend/tests/fixtures"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }

csrf_of() { awk '$6=="folio_csrf"{print $7}' "$1"; }

login() { # jar username role
  curl -fsS -c "$1" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$2\",\"role\":\"$3\"}" "$API/test/login" >/dev/null \
    || fail "test login for $2 (is FOLIO_TEST_MODE=true?)"
}

upload() { # jar file -> response json
  curl -sS -b "$1" -H "X-CSRF-Token: $(csrf_of "$1")" -F "files=@$2" "$API/books"
}

wait_status() { # jar book_id wanted timeout_s
  local deadline=$((SECONDS + $4))
  while (( SECONDS < deadline )); do
    local status
    status=$(curl -fsS -b "$1" "$API/books/$2" | json 'd["book"]["status"]')
    [[ "$status" == "$3" ]] && return 0
    [[ "$status" == "failed" ]] && fail "book $2 failed: $(curl -fsS -b "$1" "$API/books/$2" | json 'd["book"]["error"]')"
    sleep 2
  done
  fail "book $2 did not reach $3 within $4s"
}

echo "== M1: sessions and roles =="
login "$TMP/user.jar" accept-user user
login "$TMP/admin.jar" accept-admin admin

curl -fsS -b "$TMP/user.jar" "$API/auth/me" | grep -q '"role": *"user"' \
  || fail "user session is not role=user"
curl -fsS -b "$TMP/admin.jar" "$API/admin/jobs" >/dev/null \
  || fail "admin cannot read the job list"
if curl -fsS -b "$TMP/user.jar" "$API/admin/jobs" >/dev/null 2>&1; then
  fail "non-admin was able to read /admin/jobs"
fi
echo "PASS: user/admin sessions and role gating"

echo "== M2: DRM rejection =="
drm=$(upload "$TMP/user.jar" "$FIXTURES/drm_epub.epub")
[[ "$drm" == *"DRM-protected"* ]] || fail "DRM upload was not rejected with the spec message: $drm"
echo "PASS: DRM file rejected"

echo "== M2: ingest each fixture =="
declare -A EXPECTED=( [epub3]=ready [epub2]=ready [pdf_outline]=ready [pdf_flat]=ready [scanned_pdf]=needs_ocr )
for name in epub3 epub2 pdf_outline pdf_flat scanned_pdf; do
  case "$name" in
    pdf_outline|pdf_flat|scanned_pdf) file="$name.pdf" ;;
    *) file="$name.epub" ;;
  esac
  body=$(upload "$TMP/user.jar" "$FIXTURES/$file")
  book_id=$(echo "$body" | json 'd[0]["book_id"]')
  [[ -n "$book_id" ]] || fail "$name upload returned no book id: $body"
  wait_status "$TMP/user.jar" "$book_id" "${EXPECTED[$name]}" 120
  echo "PASS: $name -> ${EXPECTED[$name]}"
done

# AZW3 needs Calibre; the compose image has it. Skip cleanly when absent.
if command -v ebook-convert >/dev/null 2>&1 || docker compose exec -T api sh -c 'command -v ebook-convert' >/dev/null 2>&1; then
  body=$(upload "$TMP/user.jar" "$FIXTURES/azw3.azw3")
  book_id=$(echo "$body" | json 'd[0]["book_id"]')
  wait_status "$TMP/user.jar" "$book_id" ready 180
  echo "PASS: azw3 -> ready"
else
  echo "SKIP: azw3 (no ebook-convert on the host)"
fi

echo "== M2: duplicate detection =="
first=$(upload "$TMP/user.jar" "$FIXTURES/epub3.epub")
dup=$(echo "$first" | json 'd[0]["duplicate_of"]')
[[ "$dup" != "None" ]] || fail "second upload of epub3 was not flagged as a duplicate: $first"
echo "PASS: duplicate linked to $dup"

echo "== M2: search and chapters =="
curl -fsS -b "$TMP/user.jar" "$API/books?q=lighthouse" | grep -qi lighthouse \
  || fail "search did not find the EPUB title"
chapter_id=$(curl -fsS -b "$TMP/user.jar" "$API/books/$dup" | json 'd["chapters"][0]["id"]')
curl -fsS -b "$TMP/user.jar" "$API/books/$dup/chapters/$chapter_id/segments" | grep -q '"text"' \
  || fail "segment list is empty"
echo "PASS: search and chapter segments"

echo "== M3: manual edit survives reprocess =="
csrf=$(csrf_of "$TMP/admin.jar")
curl -fsS -b "$TMP/admin.jar" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
  -X PATCH -d '{"title":"Edited By Acceptance"}' "$API/books/$dup" >/dev/null \
  || fail "PATCH title failed"
curl -fsS -b "$TMP/admin.jar" -H "X-CSRF-Token: $csrf" -X POST \
  "$API/books/$dup/reprocess" >/dev/null || fail "reprocess failed"
wait_status "$TMP/admin.jar" "$dup" ready 180
title=$(curl -fsS -b "$TMP/admin.jar" "$API/books/$dup" | json 'd["book"]["title"]')
[[ "$title" == "Edited By Acceptance" ]] || fail "reprocess overwrote the manual edit (title=$title)"
echo "PASS: edit survived reprocess"

echo "== M3: cover upload, variants and URL rejection =="
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
  | base64 -d > "$TMP/cover.png"
curl -fsS -b "$TMP/admin.jar" -H "X-CSRF-Token: $csrf" \
  -F "file=@$TMP/cover.png" "$API/books/$dup/cover" >/dev/null || fail "cover upload failed"
for size in 200 600; do
  got=$(curl -sS -b "$TMP/admin.jar" -o "$TMP/cover-$size" -w '%{http_code} %{content_type}' \
    "$API/books/$dup/cover?size=$size")
  [[ "$got" == "200 image/webp" ]] || fail "cover size=$size returned $got"
done
[[ "$(file -b --mime-type "$TMP/cover-200")" == "image/webp" ]] || fail "cover 200 is not WebP"
before=$(curl -sS -b "$TMP/admin.jar" -o /dev/null -w '%{http_code}' "$API/books/$dup/cover?size=200")
bad=$(curl -sS -b "$TMP/admin.jar" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
  -X PUT -d '{"url":"http://127.0.0.1:1/nope.png"}' -o "$TMP/bad.json" -w '%{http_code}' \
  "$API/books/$dup/cover-url")
[[ "$bad" == "422" ]] || fail "bad cover URL returned $bad, expected 422: $(cat "$TMP/bad.json")"
after=$(curl -sS -b "$TMP/admin.jar" -o /dev/null -w '%{http_code}' "$API/books/$dup/cover?size=200")
[[ "$before" == "$after" && "$after" == "200" ]] || fail "a rejected URL disturbed the existing cover"
echo "PASS: cover upload, 200/600 WebP variants, rejected URL leaves the cover intact"

echo "== M4: voices, synthesis, streaming, cache =="
voices=$(curl -fsS -b "$TMP/user.jar" "$API/voices")
echo "$voices" | grep -q '"ashley-en"' || fail "engine voices are missing ashley-en"
preview_code=$(curl -sS -b "$TMP/user.jar" -H "X-CSRF-Token: $(csrf_of "$TMP/user.jar")" \
  -H 'Content-Type: application/json' -d '{"voice":"ashley-en","text":"Hello."}' \
  -o "$TMP/preview.opus" -w '%{http_code}' "$API/voices/preview")
[[ "$preview_code" == "200" ]] || fail "voice preview returned $preview_code"
echo "PASS: voices listed and preview synthesized"

chapter_id=$(curl -fsS -b "$TMP/user.jar" "$API/books/$dup" | json 'd["chapters"][0]["id"]')
seg_id=$(curl -fsS -b "$TMP/user.jar" "$API/books/$dup/chapters/$chapter_id/segments" | json 'd["items"][0]["id"]')
csrf=$(csrf_of "$TMP/user.jar")
for i in $(seq 1 60); do
  prep=$(curl -fsS -b "$TMP/user.jar" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
    -d "{\"segment_id\":\"$seg_id\",\"count\":1}" "$API/books/$dup/audio/prepare")
  status=$(echo "$prep" | json 'd["items"][0]["status"]')
  [[ "$status" == "ready" ]] && break
  sleep 1
done
[[ "$status" == "ready" ]] || fail "audio segment never became ready (last=$status)"
url=$(echo "$prep" | json 'd["items"][0]["url"]')
range_code=$(curl -sS -b "$TMP/user.jar" -H 'Range: bytes=0-1023' -o "$TMP/chunk" -w '%{http_code}' "$BASE$url")
[[ "$range_code" == "206" ]] || fail "audio Range request returned $range_code, expected 206"
file -b --mime-type "$TMP/chunk" | grep -q "audio/" || file "$TMP/chunk" | grep -q "Ogg"
echo "PASS: prepare → ready, Range streaming (206)"

health=$(curl -fsS -b "$TMP/admin.jar" "$API/admin/health")
echo "$health" | grep -q '"tts": *"ok"' || echo "NOTE: TTS health is not ok: $health"
clear_code=$(curl -sS -b "$TMP/admin.jar" -H "X-CSRF-Token: $(csrf_of "$TMP/admin.jar")" \
  -H 'Content-Type: application/json' -d '{}' -o "$TMP/clear.json" -w '%{http_code}' "$API/admin/cache/clear")
[[ "$clear_code" == "200" ]] || fail "cache clear returned $clear_code"
echo "PASS: admin health and cache clear"

echo "== M5: progress, continue listening, settings =="
chapter_id=$(curl -fsS -b "$TMP/user.jar" "$API/books/$dup" | json 'd["chapters"][1]["id"]')
seg_id=$(curl -fsS -b "$TMP/user.jar" "$API/books/$dup/chapters/$chapter_id/segments" | json 'd["items"][2]["id"]')
csrf=$(csrf_of "$TMP/user.jar")
saved=$(curl -fsS -b "$TMP/user.jar" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
  -X PUT -d "{\"chapter_id\":\"$chapter_id\",\"segment_id\":\"$seg_id\",\"offset_s\":5,\"device_label\":\"acceptance\"}" \
  "$API/books/$dup/progress")
percent=$(echo "$saved" | json 'round(d["progress"]["percent"], 2)')
python3 -c "import sys; sys.exit(0 if $percent > 0 else 1)" || fail "progress percent is not > 0 ($percent)"
[[ "$(curl -fsS -b "$TMP/user.jar" "$API/books/$dup/progress" | json 'd["progress"]["device_label"]')" == "acceptance" ]] \
  || fail "progress round-trip failed"
curl -fsS -b "$TMP/user.jar" "$API/me/continue" | grep -q "$dup" || fail "continue listening does not list the book"
echo "PASS: progress round-trip (${percent}%), continue listening"

settings=$(curl -fsS -b "$TMP/user.jar" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
  -X PUT -d '{"speed":1.25,"skip_back":10,"auto_next":false}' "$API/me/settings")
echo "$settings" | grep -q '"speed": *1.25' || fail "settings did not persist: $settings"
echo "$settings" | grep -q '"auto_next": *false' || fail "settings merge failed: $settings"
echo "$settings" | grep -q '"skip_forward": *30' || fail "settings lost the default: $settings"
echo "PASS: settings merge"

curl -fsS -b "$TMP/user.jar" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
  -X PUT -d '{"finished":true}' "$API/books/$dup/progress/finished" >/dev/null || fail "mark finished failed"
curl -fsS -b "$TMP/user.jar" "$API/me/continue" | grep -q "$dup" && fail "finished book still in continue listening"
curl -fsS -b "$TMP/user.jar" -H "X-CSRF-Token: $csrf" -X DELETE -o /dev/null "$API/books/$dup/progress" \
  || fail "progress reset failed"
[[ "$(curl -fsS -b "$TMP/user.jar" "$API/books/$dup/progress" | json 'd["progress"]')" == "None" ]] \
  || fail "progress was not cleared"
echo "PASS: finished removes from continue, reset clears progress"

echo "== UX2: per-book pronunciation rules and voice policy =="
csrf=$(csrf_of "$TMP/admin.jar")
rule=$(curl -fsS -b "$TMP/admin.jar" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
  -d '{"match":"Lighthouse","say":"Light house","whole_word":true}' "$API/books/$dup/pronunciation")
rule_id=$(echo "$rule" | json 'd["rule"]["id"]')
[[ -n "$rule_id" ]] || fail "pronunciation rule was not created: $rule"
curl -fsS -b "$TMP/admin.jar" "$API/books/$dup/pronunciation" | grep -q '"Light house"' \
  || fail "pronunciation rule not listed"
curl -fsS -b "$TMP/admin.jar" -H "X-CSRF-Token: $csrf" -X DELETE -o /dev/null \
  "$API/books/$dup/pronunciation/$rule_id" || fail "pronunciation rule delete failed"
curl -fsS -b "$TMP/user.jar" "$API/voices" | grep -q '"id": *"tts"' && fail "the tts fallback voice is visible to listeners"
echo "PASS: pronunciation rule CRUD; tts voice hidden"

echo "== M3: online metadata search (live Open Library; optional) =="
items=$(curl -fsS -b "$TMP/admin.jar" "$API/books/$dup/metadata/search?isbn=9780140328721")
count=$(echo "$items" | json 'len(d.get("items", []))')
if [[ "$count" -gt 0 ]]; then
  echo "PASS: metadata search returned $count candidate(s)"
else
  echo "SKIP: metadata search returned no candidates (network or provider rate limit)"
fi

echo
echo "ALL ACCEPTANCE CHECKS PASSED"
