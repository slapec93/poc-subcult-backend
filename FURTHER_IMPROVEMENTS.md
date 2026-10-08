# Further Improvements

Scope cuts and known limitations of the POC, collected so a later session can pick them up without the history. Each item says what the POC does now, what was cut, and what it would take. The architecture itself is described in `README.md`; the data model in `DATA_MODELS.md` (client material, not in this repo).

## Paid content

### Quotes and volatile currencies (removed)

**Now:** prices are in USD; buyers pay in USDC or USDT on Ethereum mainnet at a fixed 1:1 rate (`CURRENCIES`, `rate: "fixed:<usd>"` only). The buyer looks up the amount with `GET /private-parts/:id/payment`, pays, and unlocks with the transaction hash.

**Cut:** a quote step that locked a price before paying. It existed briefly and was removed before being committed, so it is not in git history. Its design:

- `POST /quotes {privatePart, currency, buyer}` converted the price into the payment currency through USD, stored a `quotes` row (`id`, `private_part_id`, `buyer`, `currency`, `amount` and `min_amount` in the smallest unit, `pay_to`, the USD rates used, `quoted_at_block`, `expires_at`, `tx_hash UNIQUE`) and returned it, valid for 15 minutes.
- The unlock message carried `quote`; the payment had to match it: right token and recipient, at least `min_amount`, from the quote's buyer, in a block after `quoted_at_block` and before `expires_at`, quote not used before.
- Rates came from config: `fixed:<usd>` or `coingecko:<id>` (CoinGecko `simple/price`, 60 s cache).

**What it takes:** any currency whose value moves against the price currency (ETH, xBZZ, EUR stablecoins for USD prices) needs quotes back, because without one the required amount changes between paying and unlocking. Re-add the table, the endpoint, `quote` in the unlock message, and non-fixed rate sources in `currencies.ts`.

### A payment is not tied to one private part

**Now:** a transaction unlocks exactly one purchase (`purchases.tx_hash` is unique), but any transfer from the buyer to the seller of at least the price, made after the part was published, can unlock any of that seller's parts at that price or lower. The seller is paid either way.

**What it takes:** either quotes (above), or putting the part id in the payment (extra calldata after an ERC-20 `transfer`, which most wallets cannot do), or a per-part payment address.

### Payment chain and gas

**Now:** payments on Ethereum mainnet (`PAYMENT_CHAIN_ID=1`). Buyers need ETH for gas besides the stablecoin, and gas can exceed a small price.

**What it takes:** moving to an L2 (Base, Arbitrum) or Gnosis is a config change: `PAYMENT_CHAIN_ID`, `PAYMENT_RPC_URL`, token ids in `CURRENCIES`. Nothing else is chain-specific. Several payment chains at once would need `paymentChainBlock` per chain.

### Payment checks not done

- **Smart-contract wallets** (Safe, ERC-4337): they sign with EIP-1271 and the transaction sender is not the signer, so unlock rejects them.
- **Payment splits** (artist and curator, label shares) and **support payments to claimed artists**: payment always goes to the private part's owner.
- **Refunds, disputes, chargebacks:** none.
- **Stablecoin depeg:** USDC and USDT are always accepted at 1:1.
- `PAYMENT_TOLERANCE_BPS` defaults to 0 (exact price).

### Keys and operators

**Now:** the seller's browser encrypts (AES-256-GCM) and sends the key to the operator named in the part's `keyHolder`, which stores it encrypted under `MASTER_KEY`. Keys and purchases never go on Swarm or the chain.

- **Only the key holder can sell.** Other operators replay and list the part but cannot unlock it; the UI shows "Sold through <keyHolder>". Routing unlock requests to the key holder, or letting a seller register the same key with several operators, is not built.
- **Lost database means lost keys.** No backup, export or key rotation. `MASTER_KEY` cannot be rotated.
- **Moving a seller to another operator:** the seller still has the key only if their client kept it; the POC browser does not keep it after upload.
- **Leaks:** any buyer can share the key or the decrypted content. Unavoidable with this model.

### Privacy

- The payment is a public transfer, linking buyer and seller addresses on-chain (not which part).
- The private part's `description`, price and seller are public, by design.

### Large files

The browser downloads and decrypts the whole file in memory. Long audio needs chunked encryption and streaming decryption.

## Identity and auth

- **Key custody:** the test frontend generates a secp256k1 key and keeps it in `localStorage`. The planned web 2 login, server-held per-user keys, or the Chrome extension holding the key are not built; signature verification works the same for any of them.
- **No user profiles:** owners are shown as short addresses.
- **`POST /media` is unauthenticated:** anyone who can reach the API spends the operator's postage stamp.
- **One operator wallet in two places:** the local stack and the dev server send `notify` transactions from the same wallet, so concurrent sends can collide on nonces (the outbox retries). Separate keys per operator, all listed in `ALLOWED_SENDERS`, is cleaner.

## Records, indexer and operators

- **Record format v3.** Unsigned v1 (`add_object`) and v2 records already on-chain are ignored. A converter was offered and not built.
- **Shared `Notify` contract.** The POC uses the livecoding.eth contract on Gnosis, shared with another app, so the indexer queues their events and ignores them by sender. Deploying a Subcult-only `Notify` contract, or filtering by sender before inserting into `chain_events`, removes the noise.
- **Bee outages fail events for good.** The indexer gives each event 8 attempts with backoff (about 8 minutes), then marks it `failed`; it needs a manual reset (`UPDATE chain_events SET status = 'pending', attempts = 0 …`). Proposed fix: treat connection errors, timeouts and 5xx from Bee as infrastructure errors that pause processing without using attempts, and count attempts only for 404s, invalid records and missing references.
- **Silent indexer:** nothing is logged per applied record.
- **Duplicate nodes from two operators:** if two operators create the same node (same identity) around the same time, the first in chain order wins and the other becomes an alias. A local view, which applies records before they are on-chain, can briefly differ from a replay.
- **Replay speed:** sequential application in chain order; a full rebuild of 100k records is estimated at about an hour with parallel fetches.
- **Multiple operators:** reading other operators' records works (signatures, `ALLOWED_SENDERS`), but re-stamping other operators' content so it survives their postage expiry is not done.

## Data model (from `DATA_MODELS.md`)

**Built:** sound, person and place nodes with identity rules; typed, authored connections with a required note; many notes per node; plain-word tags; private parts.

**Not built:**

- Node kinds: label, station/show, subcult, text, image, video, event.
- Subcults: placements (with their own note), members and roles (founder, collaborator, follower), board layout, sticky notes, private subcults (encrypted placements and connections), saved trails.
- Follows, saves, and the chronological following feed.
- Records `edit`, `retract`, `merge` (and splitting wrongly merged nodes), `join`, `invite`, `set_role`, `follow`, `unfollow`, `save`.
- Custom connection types; the list is fixed in `packages/shared/src/model.ts`.
- Tag pages; tags are only filters.
- Identity via MusicBrainz, Discogs, OpenStreetMap or Wikidata ids; only YouTube URLs are normalized properly, other links by host and path.
- Claimed person nodes (artist verification).
- Live shows and pins.
- Open questions Q6 to Q11 in the data model document are unresolved.
- An earlier requirement, "London as a place and London as a tag are one thing", no longer holds under this model (tags are words, places are nodes); it would need a search feature on top.

## Swarm

**Now:** bee-js for every Bee call; uploads are direct (`deferred: false`, slower but on the network before the record is announced) and pinned on the operator's node. Record references are computed locally with core-sdk (`ChunkSplitter.root(data).hash()`) on upload and on every download. Checked against four real single-chunk records on the network; the multi-chunk case is only tested against a mock that uses the same library, so confirm it against a real Bee node.

- **Media is not verified.** Only `/bytes` records are checked. Files go through `/bzz` (a manifest); verifying those needs the Mantaray root (core-sdk `mantaray`). The media proxy streams through `fetch` for `Range` support.
- **Client-side stamping** (core-sdk `stamper`): the operator signs postage stamps with its own batch key and uploads chunks to any Bee node or gateway, so the batch is no longer tied to one node (the `bee-dev` vs `bee-services` batch mix-up). Its effective-capacity math helps size batches.
- **Swarm-native encryption for private parts** (core-sdk `encryption`, or bee-js `encrypt: true`): the encrypted reference is address plus key, and the key half is what gets sold. Bee then decrypts while streaming, with `Range`, which fixes whole-file decryption in browser memory; the serving node sees plaintext. A design choice against the current browser-side AES-GCM.
- **Erasure coding:** uploads use no redundancy level.
- **Batch monitoring through bee-js** (`bee.stamp.get`: usable, TTL, utilization) is not wired into `/status`.

## Frontend and deployment

- **The frontend is a test page.** It loads viem and eciesjs from esm.sh at runtime; a Swarm-hosted build should bundle them.
- **Swarm-hosted frontend and the extension:** they call the API from another origin, which needs `@fastify/cors`, a public backend address (a Caddy site and the `edge` network on the dev server), and an API base URL setting instead of the `/api` proxy.
- **API docs** at `/docs` on the backend port; they do not work through the frontend's `/api` proxy.
- **Migrations:** no tool; schema changes from now on go into numbered files under `db/migrations/`.
- **Postage:** batch TTL is not monitored and not topped up automatically; immutable batches, sized from effective capacity.
- **Moderation:** none. Each operator could hide content in its own index; the chain keeps it.
- **Docker on macOS:** after a Docker Desktop restart, image builds sometimes time out on npm. `docker build --network host` works around it; restarting Docker Desktop usually fixes it.
