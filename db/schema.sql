CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE entity_type AS ENUM ('artist', 'label', 'place', 'radio_show', 'event', 'tag');
CREATE TYPE object_kind AS ENUM ('track', 'release', 'radio_show');

CREATE TABLE entities (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entities_name_trgm ON entities USING GIN (normalized_name gin_trgm_ops);

CREATE TABLE music_objects (
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
  tx_hash      text,
  CHECK (audio_ref IS NOT NULL OR external_url IS NOT NULL)
);
CREATE INDEX music_objects_created ON music_objects (created_at DESC);
CREATE INDEX music_objects_author ON music_objects (author, created_at DESC);

-- The type lives on the link: one object may use "london" as a place, another as a tag.
CREATE TABLE object_entities (
  object_id text NOT NULL REFERENCES music_objects ON DELETE CASCADE,
  entity_id text NOT NULL REFERENCES entities ON DELETE CASCADE,
  type      entity_type NOT NULL,
  PRIMARY KEY (entity_id, object_id, type)
);
CREATE INDEX object_entities_object ON object_entities (object_id);

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
