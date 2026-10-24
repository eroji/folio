# Backup and restore

Everything is restorable from two artifacts: a PostgreSQL dump and the `/data` volume. Run all commands from the compose project directory (project name `folio`, so the volumes are `folio_folio-data` and `folio_folio-db`). Substitute `folio` below if you changed `POSTGRES_USER` / `POSTGRES_DB` in `.env`.

| Artifact | Contains |
| --- | --- |
| Postgres dump | All state: users, sessions, books, chapters, segments, audio records, progress, jobs. |
| `folio_folio-data` volume | Original + converted files (`books/`), covers (`covers/`), audio cache (`audio/`). |

The **audio cache is disposable**: every file under `/data/audio` is regenerable on demand from the segment text in the database. Exclude it from backups to save space; restoring without it just means the first listen of each segment re-synthesizes.

## Back up

```bash
# database (plain SQL, gzipped)
docker compose exec -T db pg_dump -U folio -d folio | gzip > folio-db-$(date +%F).sql.gz

# /data volume, minus the regenerable audio cache
docker run --rm -v folio_folio-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/folio-data-$(date +%F).tar.gz --exclude='./audio' -C /data .
```

Copy both files off the host. Keep the `.env` too — it is not in either artifact (and never commit it).

## Restore

```bash
docker compose down

# 1. db: start postgres, recreate an empty database, load the dump
docker compose up -d db          # wait until healthy
docker compose exec -T db psql -U folio -d postgres \
  -c 'DROP DATABASE IF EXISTS folio' -c 'CREATE DATABASE folio OWNER folio'
gunzip -c folio-db-<date>.sql.gz | docker compose exec -T db psql -U folio -d folio

# 2. /data: extract as root so numeric ownership is preserved
#    (the app itself runs as a non-root user)
docker run --rm -v folio_folio-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/folio-data-<date>.tar.gz -C /data

# 3. bring the stack up — alembic runs on API start-up and no-op matches the dump's schema
docker compose up -d
```

If the dump came from an older image, deploy the matching image tag first so migrations line up.

## Verify the restore

```bash
curl -fsS http://localhost:8000/healthz     # 200 → api + db reachable
docker compose ps                           # db, api, worker all healthy
docker compose exec -T db psql -U folio -d folio -c 'SELECT count(*) FROM books;'
```

Then sign in with a directory account: the library grid must show the expected books **with covers** — covers come from `/data`, rows from Postgres, so that one page proves both artifacts restored. Open a book page and confirm its chapter list matches the pre-crash counts.
