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

## Services

| Service | Profile | Port |
| --- | --- | --- |
| `postgres` | default | 5432 |
| `backend` | default | `BACKEND_PORT` (3000) |
| `indexer` | default | none |
| `frontend` | default | `FRONTEND_PORT` (8080) |
| `anvil` + `deploy-contract` | `anvil` | 8545 |

## Run

```sh
cp .env.example .env
```

Set `BEE_URL` and `POSTAGE_BATCH_ID` for any Bee node with a usable batch.

Local chain:

```sh
# in .env, uncomment the Anvil block
docker compose --profile anvil up --build
```

Gnosis (shared contract from livecoding.eth.limo):

```sh
# in .env: OPERATOR_PRIVATE_KEY with xDAI, START_BLOCK near the current head,
# ALLOWED_SENDERS=<operator address> to skip other apps' events
docker compose up --build
```

The default `BEE_URL` points at a Bee node on the host (`http://host.docker.internal:1633`).

Open http://localhost:8080.

## API

| Method | Path | |
| --- | --- | --- |
| `POST` | `/objects` | multipart: `author`, `kind`, `title`, `note`, `externalUrl?`, `entities` (JSON `[{type, name}]`), `audio?`, `artwork?` |
| `GET` | `/objects?tag=a&tag=b&entity=<id>` | objects matching all given tags and entities |
| `GET` | `/objects/:id` | one object with its entities |
| `GET` | `/entities?q=` | autocomplete |
| `GET` | `/entities/:id` | entity with its objects |
| `GET` | `/media/:ref` | streams a Swarm file, `Range` supported |
| `GET` | `/status` | outbox, indexer cursor and confirmation counts |

## Replay

```sh
docker compose exec indexer pnpm replay --yes
```

Wipes the indexed tables and resets the cursor to `START_BLOCK`; the running indexer rebuilds everything from chain and Swarm. Posts not yet on-chain reappear once the outbox emits them.

## Not in the POC

Auth and user signatures, subcults, follows, payments and private parts, edits and deletes.
