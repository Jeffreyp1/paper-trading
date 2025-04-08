-- ==============================
-- 1) Create ENUM types
-- ==============================
CREATE TYPE order_type_enum AS ENUM ('MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LIMIT');
CREATE TYPE order_status_enum AS ENUM ('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED');
CREATE TYPE trade_type_enum AS ENUM ('BUY', 'SELL');

-- ==============================
-- 2) Users Table (Now Includes Username)
-- ==============================
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL          PRIMARY KEY,
    username        TEXT            UNIQUE NOT NULL,
    email           VARCHAR(255)    NOT NULL UNIQUE,
    password_hash   VARCHAR(255)    NOT NULL,
    role            VARCHAR(50)     NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN')),
    balance         NUMERIC(12,2)   NOT NULL DEFAULT 10000.00,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==============================
-- 3) Trades Table (Executed Trades)
-- ==============================
CREATE TABLE IF NOT EXISTS trades (
    id              SERIAL          PRIMARY KEY,
    user_id         INT             NOT NULL,
    symbol          VARCHAR(20)     NOT NULL,
    trade_type      trade_type_enum NOT NULL,
    executed_price  NUMERIC(12,2)   NOT NULL,
    quantity        INT             NOT NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_user_trades
        FOREIGN KEY (user_id)
        REFERENCES users (id)
        ON DELETE CASCADE
);

-- ==============================
-- 4) Positions Table (User’s Current Holdings)
-- ==============================
CREATE TABLE IF NOT EXISTS positions (
    id              SERIAL          PRIMARY KEY,
    user_id         INT             NOT NULL,
    symbol          VARCHAR(20)     NOT NULL,
    quantity        INT             NOT NULL DEFAULT 0,
    average_price   NUMERIC(12,2)   NOT NULL DEFAULT 0.00,
    created_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    CONSTRAINT fk_user_positions FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT unique_user_stock UNIQUE (user_id, symbol) -- 🆕 Ensures one row per user-stock pair
);

-- ==============================
-- 5) Orders Table (For Advanced Order Management)
-- ==============================
CREATE TABLE IF NOT EXISTS orders (
    id              SERIAL              PRIMARY KEY,
    user_id         INT                 NOT NULL,
    symbol          VARCHAR(20)         NOT NULL,
    order_type      order_type_enum     NOT NULL DEFAULT 'MARKET',
    trade_type      trade_type_enum     NOT NULL,
    status          order_status_enum   NOT NULL DEFAULT 'OPEN',
    quantity        INT                 NOT NULL,
    price           NUMERIC(12,2),
    created_at      TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_user_orders
        FOREIGN KEY (user_id)
        REFERENCES users (id)
        ON DELETE CASCADE
);

-- ==============================
-- 6) Watchlists Table (Optional – Tracks Favorite Stocks)
-- ==============================
CREATE TABLE IF NOT EXISTS watchlists (
    id              SERIAL          PRIMARY KEY,
    user_id         INT             NOT NULL,
    name            VARCHAR(100)    NOT NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_user_watchlists
        FOREIGN KEY (user_id)
        REFERENCES users (id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS watchlist_items (
    id              SERIAL          PRIMARY KEY,
    watchlist_id    INT             NOT NULL,
    symbol          VARCHAR(20)     NOT NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_watchlist
        FOREIGN KEY (watchlist_id)
        REFERENCES watchlists (id)
        ON DELETE CASCADE
);