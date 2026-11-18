-- Schema for the unified get release API.
--
-- Neon is the source of truth for what exists. The object store holds the
-- bytes, and a channel head is an explicit pointer rather than "the highest
-- version present". That keeps an unordered track such as nightly from being
-- ordered against stable by semver.

CREATE TABLE products (
  slug       text PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  product  text NOT NULL REFERENCES products(slug) ON DELETE CASCADE,
  name     text NOT NULL,
  fallback text,
  PRIMARY KEY (product, name),
  FOREIGN KEY (product, fallback) REFERENCES channels(product, name)
);

CREATE TABLE releases (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product      text NOT NULL,
  channel      text NOT NULL,
  version      text NOT NULL,
  notes        text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product, channel, version),
  FOREIGN KEY (product, channel) REFERENCES channels(product, name)
);

CREATE TABLE artifacts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id   bigint NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  platform     text NOT NULL,
  kind         text NOT NULL,
  object_key   text NOT NULL,
  sha256       text NOT NULL,
  size_bytes   bigint NOT NULL,
  content_type text,
  UNIQUE (release_id, platform, kind)
);

CREATE TABLE channel_heads (
  product    text NOT NULL,
  channel    text NOT NULL,
  release_id bigint NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product, channel),
  FOREIGN KEY (product, channel) REFERENCES channels(product, name)
);

CREATE TABLE publish_messages (
  message_id  text PRIMARY KEY,
  product     text NOT NULL,
  channel     text NOT NULL,
  version     text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX releases_product_channel_idx ON releases (product, channel);
CREATE INDEX artifacts_release_platform_idx ON artifacts (release_id, platform);

INSERT INTO products (slug, name) VALUES
  ('build', 'Build'),
  ('build-tool', 'build-tool'),
  ('kiln', 'Kiln');

INSERT INTO channels (product, name, fallback) VALUES
  ('build', 'stable', NULL),
  ('build', 'beta', 'stable'),
  ('build', 'nightly', 'stable'),
  ('build-tool', 'stable', NULL),
  ('kiln', 'stable', NULL),
  ('kiln', 'beta', NULL),
  ('kiln', 'rc', NULL),
  ('kiln', 'lts', NULL),
  ('kiln', 'alpha', NULL),
  ('kiln', 'canary', NULL);
