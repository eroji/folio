.PHONY: install db reset-test-db dev-backend dev-web test test-web lint e2e up down logs fixtures

# Host has python3, not python; everything backend-side runs from this venv.
VENV := backend/.venv
PY := $(VENV)/bin/python

install:
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -e ./backend
	$(VENV)/bin/pip install pytest==9.1.1 pytest-asyncio==1.4.0 ruff==0.17.2 mypy==2.4.0

db:
	docker compose up -d db

dev-backend:
	cd backend && .venv/bin/alembic upgrade head && .venv/bin/uvicorn folio.main:app --reload --port 8000

dev-web:
	cd frontend && npm run dev

# create_all never alters an existing table: after adding a migration, reset
# the test schema or every test touching the new column fails.
reset-test-db: db
	docker compose exec -T db psql -U folio -d postgres \
		-c 'DROP DATABASE IF EXISTS folio_test' -c 'CREATE DATABASE folio_test OWNER folio'

test: db
	cd backend && .venv/bin/python -m pytest tests/

test-web:
	cd frontend && npm test -- --run

lint:
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy folio
	@if [ -f frontend/package.json ]; then cd frontend && npm run lint && npx tsc --noEmit; fi

# Clean volume on purpose: the suite asserts the empty library and uploads a
# fixture that content-hash dedupe would reject on a reused database.
e2e:
	docker compose -f compose.yaml -f compose.test.yaml down -v
	docker compose -f compose.yaml -f compose.test.yaml up -d --build
	@for i in $$(seq 1 60); do curl -fsS localhost:8000/healthz >/dev/null 2>&1 && break; sleep 2; done
	cd frontend && npx playwright test

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f api worker

# Fixture books are gitignored; azw3 falls back to a detection-only stub when
# Calibre is not installed on the host (`make e2e` converts it in the image).
fixtures:
	cd backend && .venv/bin/python -m scripts.make_fixtures
