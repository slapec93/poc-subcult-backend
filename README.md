# Subcult backend POC

Implements the node model from `DATA_MODELS.md`: nodes (sound, person, place) with one identity each, typed and authored connections, many notes per node, and plain-word tags. Every contribution is a signed record on Swarm, announced on-chain through a `Notify` contract and served from Postgres. The indexer can rebuild Postgres from the chain alone.

## Records

| Record | Creates |
| --- | --- |
| `add_node` | A node; may carry the first saver's note and tags. A sound needs a note, and audio or a link |
| `add_note` | A note on a node |
| `add_connection` | A typed connection between two nodes, with a required note and an optional source |
| `add_tag` | A tag on a node |

Records use format version 2 and share an envelope: `app`, `v`, `type`, `author`, `createdAt`, `nonce`, `signature`, `payload`. A node's id is the Swarm reference of its `add_node` record. A node with the same identity (a sound's source URL, a person's name, a place's name and location) is never created twice: the API adds to the existing node, and a duplicate `add_node` from another operator becomes an alias of the first.

Connection types: Recorded by, Played by DJ, Played at, Recorded at, Played in set, Continues in, Resident at. Each type limits which node kinds it joins (`packages/shared/src/model.ts`).

## Packages

| Package | Role |
| --- | --- |
| `packages/backend` | API server: uploads media and record JSON to Swarm, writes Postgres, emits `notify(swarmRef)` via an outbox |
| `packages/indexer` | Reads `Notification` events, fetches records from Swarm in parallel and applies them in chain order |
| `packages/shared` | Record schemas, node identity, connection types, idempotent `applyRecord`, Swarm and chain helpers |
| `packages/frontend` | Static test page served by nginx, proxies `/api` to the backend |

Record ids are Swarm references, and every write is idempotent, so a record applied by the API and later seen on-chain by the indexer is stored once.

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
| `POST` | `/nodes` | multipart: `author`, `kind`, `title`, `role?`, `where?`, `years?`, `externalUrl?`, `format?`, `note?`, `tags?` (comma separated), `audio?`, `artwork?`. Returns `existing: true` when it added to an existing node |
| `GET` | `/nodes?kind=&q=&tag=a&tag=b` | nodes, newest first; tags must all match |
| `GET` | `/nodes/:id` | node with its tags, notes and connections, each connection labelled from this node's side |
| `POST` | `/nodes/:id/notes` | JSON `{author, text}` |
| `POST` | `/nodes/:id/tags` | JSON `{author, tags: []}` |
| `POST` | `/connections` | JSON `{author, from, type, to \| toNode: {kind, title, where?}, note, source?}`; `toNode` finds or creates the target |
| `GET` | `/connection-types` | types with their allowed node kinds |
| `GET` | `/tags?q=` | tag autocomplete with counts |
| `GET` | `/media/:ref` | streams a Swarm file, `Range` supported |
| `GET` | `/status` | outbox, indexer cursor and confirmation counts |

## Replay

```sh
docker compose exec indexer pnpm replay --yes
```

Wipes the indexed tables and resets the cursor to `START_BLOCK`; the running indexer rebuilds everything from chain and Swarm. Records not yet on-chain reappear once the outbox emits them.

## Not in the POC

Auth and user signatures, label/show/subcult nodes, placements, follows and saves, payments and private parts, edits, retractions and merges.
