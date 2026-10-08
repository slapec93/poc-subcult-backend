# Subcult backend POC

Implements the node model from `DATA_MODELS.md`: nodes (sound, person, place) with one identity each, typed and authored connections, many notes per node, and plain-word tags. Every contribution is a signed record on Swarm, announced on-chain through a `Notify` contract and served from Postgres. The indexer can rebuild Postgres from the chain alone.

## Records

| Record | Creates |
| --- | --- |
| `add_node` | A node; may carry the first saver's note and tags. A sound needs a note, and audio or a link |
| `add_note` | A note on a node |
| `add_connection` | A typed connection between two nodes, with a required note and an optional source |
| `add_tag` | A tag on a node |
| `add_private_part` | Encrypted content on a node, sold for a price; its key stays with the operator named as `keyHolder` |

Records use format version 3 and share an envelope: `app`, `v`, `type`, `owner`, `createdAt`, `nonce`, `payload`, `signature`. The owner signs each record with EIP-191 `personal_sign` over the record without `signature`, serialized as JSON with sorted keys and no whitespace. The API and the indexer both recover the signer and reject records whose signature doesn't match `owner`; unknown fields and links other than `http(s)` are rejected. A node's id is the Swarm reference of its `add_node` record. A node with the same identity (a sound's source URL, a person's name, a place's name and location) is never created twice: the API adds to the existing node, and a duplicate `add_node` from another operator becomes an alias of the first.

Connection types: Recorded by, Played by DJ, Played at, Recorded at, Played in set, Continues in, Resident at. Each type limits which node kinds it joins (`packages/shared/src/model.ts`).

## Packages

| Package | Role |
| --- | --- |
| `packages/backend` | API server: uploads media and record JSON to Swarm, writes Postgres, emits `notify(swarmRef)` via an outbox |
| `packages/indexer` | Reads `Notification` events, fetches records from Swarm in parallel and applies them in chain order |
| `packages/shared` | Record schemas, node identity, connection types, idempotent `applyRecord`, Swarm (bee-js) and chain helpers |
| `packages/frontend` | Static test page served by nginx, proxies `/api` to the backend |

Record ids are Swarm references, and every write is idempotent, so a record applied by the API and later seen on-chain by the indexer is stored once. Swarm access goes through bee-js; uploads are direct (not deferred) and pinned. Record references are computed locally with `@ethersphere/core-sdk`, both to check what Bee returns on upload and to verify every downloaded record, so an untrusted Bee node or gateway cannot substitute content.

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

Interactive docs (Swagger UI) at `/docs` on the backend, e.g. http://localhost:3000/docs; the OpenAPI spec at `/docs/json`.

Writing a record:

1. `POST /media` with a `file` (optional) → `ref`, used as `audioRef` or `artworkRef`.
2. `POST /records/prepare` with `{type, owner, payload}` → the normalized `record` and the `message` to sign.
3. Sign `message` with the owner's key, then `POST /records` with `{...record, signature}`.

| Method | Path | |
| --- | --- | --- |
| `POST` | `/records/prepare` | normalize and validate a payload; returns the record and message to sign |
| `POST` | `/records` | submit a signed record |
| `GET` | `/records/:id` | a stored record with its chain status |
| `POST` | `/media` | upload audio or an image to Swarm |
| `GET` | `/media/:ref` | stream a Swarm file, `Range` supported |
| `GET` | `/nodes?kind=&q=&tag=a&tag=b` | nodes, newest first; tags must all match |
| `GET` | `/nodes/:id` | node with its tags, notes and connections, each connection labelled from this node's side |
| `GET` | `/tags?q=` | tag autocomplete with counts |
| `GET` | `/connection-types` | types with their allowed node kinds |
| `GET` | `/status` | outbox, indexer cursor and confirmation counts |

## Paid content

A private part is public metadata (price, seller, `encryptedRef`, `keyHolder`) over content encrypted with AES-256-GCM in the seller's browser. The decryption key never goes on Swarm or the chain: the seller hands it to the key holder operator, which stores it encrypted under `MASTER_KEY`.

Prices are in USD; buyers pay in USDC or USDT on Ethereum mainnet, at 1:1, directly to the seller, and need ETH for gas. Payments are on a separate chain from the records (`PAYMENT_CHAIN_ID`, `PAYMENT_RPC_URL`). Currencies are CAIP-19 ids in the record format (`iso4217:USD`, `eip155:1/erc20:<token>`), so other price or payment currencies are a `CURRENCIES` change, not a format change.

| Step | Call |
| --- | --- |
| Seller publishes | encrypt, `POST /media` the ciphertext, sign `add_private_part`, then `POST /private-parts/:id/key` with the key, signed |
| Buyer looks up the price | `GET /private-parts/:id/payment`: the seller's address, the amount per accepted token, and `afterBlock` |
| Buyer pays | a plain token transfer to the seller, from the buyer's address, from any wallet |
| Buyer unlocks | `POST /unlock` with `{privatePart, buyer, txHash, expiresAt}` signed; the key comes back ECIES-encrypted to the buyer's public key |
| Buyer returns | `POST /unlock` without `txHash` |

Each private part records `paymentChainBlock`, the payment chain's head when it was published (filled in by prepare, checked against the real head on submit). An unlock is refused unless the transaction succeeded with enough confirmations, came from the buyer, paid the seller at least the price in an accepted token, landed in a later block than `paymentChainBlock`, and was not used before. Keys and purchases are operator-only tables: a replay rebuilds private parts but never touches them, and another operator can list a part but cannot sell it.

## Replay

```sh
docker compose exec indexer pnpm replay --yes
```

Wipes the indexed tables and resets the cursor to `START_BLOCK`; the running indexer rebuilds everything from chain and Swarm. Records not yet on-chain reappear once the outbox emits them.

## Not in the POC

See `FURTHER_IMPROVEMENTS.md` for every scope cut and known limitation.
