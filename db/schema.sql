CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE entity_type AS ENUM ('artist', 'label', 'place', 'radio_show', 'event', 'tag');
CREATE TYPE object_kind AS ENUM ('track', 'release', 'radio_show');

CREATE TABLE entity (
  id              text PRIMARY KEY,
  type            entity_type NOT NULL,
  name            text NOT NULL,
  normalized_name text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, normalized_name)
);
CREATE INDEX entity_name_trgm ON entity USING GIN (normalized_name gin_trgm_ops);

CREATE TABLE music_object (
  id           text PRIMARY KEY,
  author       text NOT NULL,
  kind         object_kind NOT NULL,
  title        text NOT NULL,
  note         text NOT NULL CHECK (note <> ''),
  artwork_ref  text,
  audio_ref    text,
  external_url text,
  created_at   timestamptz NOT NULL,
  block_number bigint,
  log_index    int,
  tx_hash      text
);
CREATE INDEX music_object_created ON music_object (created_at DESC);
CREATE INDEX music_object_author ON music_object (author, created_at DESC);

CREATE TABLE object_entity (
  object_id text NOT NULL REFERENCES music_object ON DELETE CASCADE,
  entity_id text NOT NULL REFERENCES entity ON DELETE CASCADE,
  PRIMARY KEY (entity_id, object_id)
);
CREATE INDEX object_entity_object ON object_entity (object_id);

CREATE TABLE chain_outbox (
  swarm_ref       text PRIMARY KEY,
  status          text NOT NULL DEFAULT 'pending',
  tx_hash         text,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chain_event (
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
CREATE INDEX chain_event_pending ON chain_event (next_attempt_at) WHERE status = 'pending';

CREATE TABLE indexer_state (
  id         int PRIMARY KEY CHECK (id = 1),
  next_block bigint NOT NULL
);
