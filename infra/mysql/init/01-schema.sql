-- Lumen Auction schema (proto/db-schema.md). Applied on first MySQL init.
-- MySQL is the fact store; Redis Lua owns the hot path.

CREATE TABLE IF NOT EXISTS users (
  id         VARCHAR(64) PRIMARY KEY,
  nickname   VARCHAR(128) NOT NULL,
  avatar     VARCHAR(512) NULL,
  role       VARCHAR(32)  NOT NULL DEFAULT 'user',
  created_at DATETIME     NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          VARCHAR(64) PRIMARY KEY,
  seller_id   VARCHAR(64)  NOT NULL,
  name        VARCHAR(255) NOT NULL,
  image_url   VARCHAR(1024) NULL,
  description TEXT NULL,
  status      VARCHAR(32)  NOT NULL DEFAULT 'active',
  created_at  DATETIME     NOT NULL,
  updated_at  DATETIME     NOT NULL,
  INDEX idx_products_seller (seller_id, status, created_at)
);

CREATE TABLE IF NOT EXISTS auctions (
  id                  VARCHAR(64) PRIMARY KEY,
  product_id          VARCHAR(64) NOT NULL,
  seller_id           VARCHAR(64) NOT NULL,
  status              VARCHAR(32) NOT NULL,
  current_price_cents BIGINT      NOT NULL DEFAULT 0,
  winner_id           VARCHAR(64) NULL,
  seq                 BIGINT      NOT NULL DEFAULT 0,
  facts_confirmed     TINYINT(1)  NOT NULL DEFAULT 0,
  confirmed_facts_json JSON       NULL,
  start_at            DATETIME    NULL,
  end_at              DATETIME    NULL,
  finished_at         DATETIME    NULL,
  cancel_reason       VARCHAR(255) NULL,
  created_at          DATETIME    NOT NULL,
  updated_at          DATETIME    NOT NULL,
  INDEX idx_auctions_status (status, start_at, end_at)
);

CREATE TABLE IF NOT EXISTS auction_rules (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  auction_id        VARCHAR(64) NOT NULL,
  start_price_cents BIGINT NOT NULL,
  increment_cents   BIGINT NOT NULL,
  cap_price_cents   BIGINT NOT NULL,
  duration_sec      BIGINT NOT NULL,
  extend_window_sec BIGINT NOT NULL DEFAULT 0,
  extend_sec        BIGINT NOT NULL DEFAULT 0,
  max_extensions    BIGINT NOT NULL DEFAULT 0, -- 0 = unlimited anti-snipe extensions
  frozen_at         DATETIME NULL,
  UNIQUE KEY uq_rules_auction (auction_id)
);

CREATE TABLE IF NOT EXISTS bids (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  auction_id    VARCHAR(64) NOT NULL,
  user_id       VARCHAR(64) NOT NULL,
  amount_cents  BIGINT NOT NULL,
  seq           BIGINT NOT NULL,
  client_bid_id VARCHAR(128) NOT NULL,
  source        VARCHAR(32) NULL,
  accepted_at   DATETIME NOT NULL,
  UNIQUE KEY uq_bids_seq (auction_id, seq),
  UNIQUE KEY uq_bids_client (auction_id, user_id, client_bid_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id           VARCHAR(64) PRIMARY KEY,
  auction_id   VARCHAR(64) NOT NULL,
  product_id   VARCHAR(64) NOT NULL,
  buyer_id     VARCHAR(64) NOT NULL,
  amount_cents BIGINT NOT NULL,
  status       VARCHAR(32) NOT NULL DEFAULT 'created',
  created_at   DATETIME NOT NULL,
  paid_at      DATETIME NULL,
  UNIQUE KEY uq_orders_auction (auction_id)
);

-- event_hash / prev_hash are nullable in T1; the hash chain is computed by the
-- Persistence Worker (MySQL-only integrity check) at T4.
CREATE TABLE IF NOT EXISTS auction_events (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  auction_id   VARCHAR(64) NOT NULL,
  seq          BIGINT NOT NULL,
  event_type   VARCHAR(64) NOT NULL,
  payload_json JSON NULL,
  created_at   DATETIME NOT NULL,
  event_hash   VARCHAR(128) NULL,
  prev_hash    VARCHAR(128) NULL,
  hmac_key_version SMALLINT NOT NULL DEFAULT 1,
  UNIQUE KEY uq_events_seq (auction_id, seq),
  INDEX idx_events_auction (auction_id, seq)
);

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  scenario       VARCHAR(64) NOT NULL,
  model_name     VARCHAR(128) NULL,
  input_summary  TEXT NULL,
  output_summary TEXT NULL,
  human_reviewed TINYINT(1) NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL
);
