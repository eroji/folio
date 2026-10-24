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
  ext=epub; [[ "$name" == pdf* ]] && ext=pdf
  body=$(upload "$TMP/user.jar" "$FIXTURES/$name.$ext")
  book_id=$(echo "$body" | json 'd[0]["book_id"]')
  [[ -n "$book_id" ]] || fail "$name upload returned no book id: $body"
  wait_status "$TMP/user.jar" "$book_id" "${EXPECTED[$name]}" 120
  echo "PASS: $name -> ${EXPECTED[$name]}"
done

# AZW3 needs Calibre; the compose image has it. Skip cleanly when absent.
if command -v ebook-convert >/dev/null 2>&1 || docker compose exec -T api command -v ebook-convert >/dev/null 2>&1; then
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

echo
echo "ALL ACCEPTANCE CHECKS PASSED"
