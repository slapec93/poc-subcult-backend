CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Every applied record, as published on Swarm; ids elsewhere are the refs of the records that created them.
CREATE TABLE records (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  author       text NOT NULL,
  created_at   timestamptz NOT NULL,
  body         jsonb NOT NULL,
  block_number bigint,
  log_index    int,
  tx_hash      text
);
CREATE INDEX records_author ON records (author, created_at DESC);

CREATE TABLE nodes (
  id           text PRIMARY KEY REFERENCES records,
  kind         text NOT NULL,
  title        text NOT NULL,
  role         text,
  locality     text,
  years        text,
  external_url text,
  format       text,
  audio_ref    text,
  artwork_ref  text,
  identity_key text UNIQUE,
  added_by     text NOT NULL,
  created_at   timestamptz NOT NULL
);
CREATE INDEX nodes_kind_created ON nodes (kind, created_at DESC);
CREATE INDEX nodes_created ON nodes (created_at DESC);
CREATE INDEX nodes_title_trgm ON nodes USING GIN (lower(title) gin_trgm_ops);

-- A creation record for a node that already existed points here instead of creating a duplicate.
CREATE TABLE node_aliases (
  alias_id text PRIMARY KEY REFERENCES records,
  node_id  text NOT NULL REFERENCES nodes
);

CREATE TABLE notes (
  id         text PRIMARY KEY REFERENCES records,
  node_id    text NOT NULL REFERENCES nodes,
  author     text NOT NULL,
  text       text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX notes_node ON notes (node_id, created_at DESC);

CREATE TABLE connections (
  id         text PRIMARY KEY REFERENCES records,
  from_id    text NOT NULL REFERENCES nodes,
  type       text NOT NULL,
  to_id      text NOT NULL REFERENCES nodes,
  author     text NOT NULL,
  note       text NOT NULL,
  source     text,
  created_at timestamptz NOT NULL,
  UNIQUE (from_id, type, to_id)
);
CREATE INDEX connections_to ON connections (to_id);

CREATE TABLE node_tags (
  node_id    text NOT NULL REFERENCES nodes,
  tag        text NOT NULL,
  record_id  text NOT NULL REFERENCES records,
  added_by   text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (node_id, tag)
);
CREATE INDEX node_tags_tag ON node_tags (tag);

CREATE TABLE chain_outbox (
  swarm_ref       text PRIMARY KEY,
  status          text NOT NULL DEFAULT 'pending',
  tx_hash         text,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chain_events (
  block_number    bigint NOT NULL,
  log_index       int NOT NULL,
  tx_hash         text NOT NULL,
  swarm_ref       text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  PRIMARY KEY (block_number, log_index)
);
CREATE INDEX chain_events_pending ON chain_events (next_attempt_at) WHERE status = 'pending';

CREATE TABLE indexer_state (
  id         int PRIMARY KEY CHECK (id = 1),
  next_block bigint NOT NULL
);
