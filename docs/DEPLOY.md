# Deploy

Folio ships as one OCI image. A git tag builds it, pushes it to Harbor, and recreates the
stack on `folio.dotslash.io`. Nothing is built or deployed from a branch push.

## What the pipeline does

1. **build** (docker:27-dind): `docker build -f Dockerfile` → pushes
   `harbor.dotslash.io/dotslash/folio:vX.Y.Z` and `:latest`.
2. **deploy** (alpine + ssh): copies `compose.yaml`, `deploy/compose.https.yaml` and
   `deploy/nginx/folio.conf` to `/opt/folio`, logs in to Harbor on the server, rewrites the
   `FOLIO_IMAGE=` line in `/opt/folio/.env`, then
   `docker compose -f compose.yaml -f compose.https.yaml pull && up -d --remove-orphans`.
   It waits for `http://127.0.0.1:8000/healthz` **and** `https://folio.dotslash.io/healthz`
   (5 s × 60 attempts) and prints the compose logs if either stays down.

Production runs `compose.yaml` plus the `deploy/compose.https.yaml` override: nginx
terminates TLS on :80/:443 and the api is published on loopback only
(`FOLIO_PORT=127.0.0.1:8000` in the server `.env`).

## CI variables

| Variable | Purpose |
| --- | --- |
| `HARBOR_USER` | Harbor user/robot with push rights to `dotslash/folio`. |
| `HARBOR_TOKEN` | Its password/robot token, piped to `docker login --password-stdin`. |
| `DEPLOY_SSH_KEY` | `base64 -w0` of an ed25519 private key; the public half is in `deploy@folio.dotslash.io:~/.ssh/authorized_keys`. |

They are project/group variables already set — no others are needed. Tag pipelines require
them to be unprotected, or the tag to be protected.

## One-time server setup

As a sudoer on `folio.dotslash.io`:

```bash
sudo mkdir -p /opt/folio && sudo chown deploy:deploy /opt/folio
```

Then as `deploy`:

- `/opt/folio/.env` — from `.env.example`: real `FOLIO_BASE_URL=https://folio.dotslash.io`,
  `FOLIO_SECRET_KEY`, the LDAP block, the TTS block, `MAX_UPLOAD_MB=200`, the Postgres
  passwords, `FOLIO_PORT=127.0.0.1:8000`, and `chmod 600 .env`. `FOLIO_IMAGE` is written by
  the pipeline.
- `/opt/folio/tls/fullchain.pem` + `/opt/folio/tls/privkey.pem` — copy the wildcard
  `*.dotslash.io` certificate from notely (`/opt/notely/config/nginx/tls`) and keep it in sync.
  **Renew before 2026-11-23.** Not in git, mounted read-only.
- `/opt/folio/tls/ldap-ca.pem` — the internal `DotSlash-CA` that signs the domain controller's
  LDAPS certificate (`/etc/pki/ca-trust/source/anchors/dotslash-ca.crt` on the host). Mounted
  read-only into the api as `/etc/ssl/folio/ldap-ca.pem` and pointed at by `LDAP_CA_FILE`;
  without it the bind fails with a certificate error because the image has no internal CA.
- The deploy key's public half in `~/.ssh/authorized_keys`. The `deploy` user has no sudo
  and only needs to be in the `docker` group.

### `.env` pitfalls

- **Single-quote any value containing `$`.** Compose interpolates `env_file` values, so an
  unquoted bind password like `ab$cd` reaches the container empty or truncated. `'ab$cd'` is
  taken literally.
- Changing `.env` needs a **recreate**, not a restart (`restart` keeps the old environment):
  `docker compose -f compose.yaml -f compose.https.yaml up -d --force-recreate api worker`.

## Release

```bash
git tag -a v1.2.3 -m "Folio 1.2.3"
git push origin v1.2.3
```

Watch the pipeline; the deploy job ends with `READY`.

## Verify

```bash
cd /opt/folio
docker compose -f compose.yaml -f compose.https.yaml ps   # api, worker, db, nginx all Up/healthy
curl -fsS https://folio.dotslash.io/healthz               # through nginx
```

## Rollback

Set the previous tag in `/opt/folio/.env` and recreate — no rebuild needed, the old image is
still in Harbor:

```bash
cd /opt/folio
sed -i "s|^FOLIO_IMAGE=.*|FOLIO_IMAGE=harbor.dotslash.io/dotslash/folio:v1.2.2|" .env
docker compose -f compose.yaml -f compose.https.yaml up -d
```

Migrations run on api start-up and are not reverted; if a release contains a breaking
migration, restore the database too (see [BACKUP.md](BACKUP.md)).
