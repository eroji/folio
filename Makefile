.PHONY: install db dev-backend dev-web test test-web lint e2e up down logs fixtures

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

test: db
	cd backend && .venv/bin/python -m pytest tests/

test-web:
	cd frontend && npm test -- --run

lint:
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy folio
	@if [ -f frontend/package.json ]; then cd frontend && npm run lint && npx tsc --noEmit; fi

e2e:
	docker compose -f compose.yaml -f compose.test.yaml up -d --build
	cd frontend && npx playwright test

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f api worker

# Task 3 owns backend/scripts/make_fixtures.py; this fails until it lands.
fixtures:
	cd backend && .venv/bin/python -m scripts.make_fixtures
