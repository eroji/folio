.PHONY: db dev-backend dev-web test test-web lint e2e up down logs fixtures

db:
	docker compose up -d db

dev-backend:
	cd backend && alembic upgrade head && uvicorn folio.main:app --reload --port 8000

dev-web:
	cd frontend && npm run dev

test: db
	cd backend && python -m pytest tests/

test-web:
	cd frontend && npm test -- --run

lint:
	cd backend && ruff check . && ruff format --check . && mypy folio
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
	cd backend && python -m scripts.make_fixtures
