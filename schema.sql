-- Idempotent: safe to run on every boot.
-- 3NF notes: derived counters (grab_count, subscriber_count) are removed (use COUNT(*)).
-- radio_station_items.owner_id is a deliberate, documented denormalization: it lets a
-- composite FK guarantee a station only plays its owner's recordings.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  avatar_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recordings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_recording_id uuid NOT NULL DEFAULT gen_random_uuid(),
  title               text NOT NULL DEFAULT 'Untitled',
  description         text,
  duration_ms         integer NOT NULL CHECK (duration_ms >= 0),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  storage_state       text NOT NULL DEFAULT 'local_only'
                      CHECK (storage_state IN ('local_only','uploading','uploaded','failed')),
  object_key          text,
  visibility          text NOT NULL DEFAULT 'private'
                      CHECK (visibility IN ('private','radio','shared')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  UNIQUE (owner_id, client_recording_id),
  UNIQUE (id, owner_id),
  CHECK (visibility = 'private' OR storage_state = 'uploaded'),
  CHECK (storage_state <> 'uploaded' OR object_key IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS recordings_owner_recorded ON recordings (owner_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS recordings_shared ON recordings (created_at DESC)
  WHERE visibility = 'shared' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS recording_grabs (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recording_id uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  grabbed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, recording_id)
);
CREATE INDEX IF NOT EXISTS grabs_recording ON recording_grabs (recording_id);

CREATE TABLE IF NOT EXISTS radio_stations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text,
  is_live            boolean NOT NULL DEFAULT false,
  current_item_id    uuid,
  current_started_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id)
);

CREATE TABLE IF NOT EXISTS radio_station_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id   uuid NOT NULL,
  owner_id     uuid NOT NULL,
  recording_id uuid NOT NULL,
  position     integer NOT NULL CHECK (position > 0),
  added_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (station_id, owner_id)   REFERENCES radio_stations(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (recording_id, owner_id) REFERENCES recordings(id, owner_id) ON DELETE CASCADE,
  UNIQUE (station_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS items_recording ON radio_station_items (recording_id);

DO $$ BEGIN
  ALTER TABLE radio_stations ADD CONSTRAINT stations_current_item_fk
    FOREIGN KEY (current_item_id) REFERENCES radio_station_items(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS radio_subscriptions (
  station_id    uuid NOT NULL REFERENCES radio_stations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station_id, user_id)
);
CREATE INDEX IF NOT EXISTS subs_user ON radio_subscriptions (user_id);
