# Subcult backend POC

Posts are stored on Swarm, announced on-chain through a `Notify` contract, and served from Postgres. The indexer can rebuild Postgres from the chain alone.

## Packages

| Package | Role |
| --- | --- |
| `packages/backend` | API server: uploads media and event JSON to Swarm, writes Postgres, emits `notify(swarmRef)` via an outbox |
| `packages/indexer` | Reads `Notification` events, fetches the event JSON from Swarm, applies it to Postgres |
| `packages/shared` | Event schema, idempotent `applyEvent`, Swarm and chain helpers used by both |
| `packages/frontend` | Static test page served by nginx, proxies `/api` to the backend |

Event ids are Swarm references, and every write is `ON CONFLICT DO NOTHING`, so an event applied by the API and later seen on-chain by the indexer is stored once.

## Compose files

| File | Services | Use |
| --- | --- | --- |
| `docker-compose.dev.yml` | `postgres`, `backend`, `indexer`, `frontend`; `anvil` + `deploy-contract` with `--profile anvil` | Local development |
| `docker-compose.yml` | `backend`, `indexer` | Dev server: external Postgres via `DATABASE_URL`, Bee via the shared `swarm` network |

## Run locally

```sh
cp .env.example .env
```

Set `BEE_URL` and `POSTAGE_BATCH_ID` for any Bee node with a usable batch. The default `BEE_URL` points at a Bee node on the host (`http://host.docker.internal:1633`).

Local chain:

```sh
# in .env, uncomment the Anvil block
docker compose -f docker-compose.dev.yml --profile anvil up --build
```

Gnosis (shared contract from livecoding.eth.limo):

```sh
# in .env: OPERATOR_PRIVATE_KEY with xDAI, START_BLOCK near the current head,
# ALLOWED_SENDERS=<operator address> to skip other apps' events
docker compose -f docker-compose.dev.yml up --build
```

Open http://localhost:8080.

## Dev server

`docker-compose.yml` joins two external networks: `swarm` (Bee as `bee:1633`) and the Postgres project's network (`DB_NETWORK`, default `postgres_default`, database host `postgres`). In `.env`:

```sh
DATABASE_URL=postgres://subcult:<password>@postgres:5432/subcult
BEE_URL=http://bee:1633
```

Load `db/schema.sql` into the database once before the first start, or run `scripts/recreate-db.sh`, which drops and recreates it. Later schema changes go into numbered files under `db/migrations/` (`001-<change>.sql`, …), applied in order on top of an existing database. The backend binds to `127.0.0.1` only; the frontend is deployed to Swarm separately.

## API

| Method | Path | |
| --- | --- | --- |
| `POST` | `/objects` | multipart: `author`, `kind`, `title`, `note`, `externalUrl?`, `entities` (JSON `[{type, name}]`), `audio?`, `artwork?` |
| `GET` | `/objects?name=a&name=b&entity=<id>` | objects linked to all given entities, by name or id, whatever type they were linked as |
| `GET` | `/objects/:id` | one object with its entities |
| `GET` | `/entities?q=` | autocomplete |
| `GET` | `/entities/:id` | entity, the types it is used as, and its objects |
| `GET` | `/media/:ref` | streams a Swarm file, `Range` supported |
| `GET` | `/status` | outbox, indexer cursor and confirmation counts |

## Replay

```sh
docker compose exec indexer pnpm replay --yes
```

Wipes the indexed tables and resets the cursor to `START_BLOCK`; the running indexer rebuilds everything from chain and Swarm. Posts not yet on-chain reappear once the outbox emits them.

## Not in the POC

Auth and user signatures, subcults, follows, payments and private parts, edits and deletes.
