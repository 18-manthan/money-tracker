import cors from "cors";
import express from "express";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const SQLITE_FILE = join(DATA_DIR, "money-tracker.sqlite");
const LEGACY_JSON_FILE = join(DATA_DIR, "db.json");
const PORT = process.env.PORT || 4000;
const DATABASE_URL =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.STORAGE_URL || "";
const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";
const ALLOW_CREATE_USER = process.env.ALLOW_CREATE_USER === "true";

const ALLOWED_TRANSACTION_TYPES = {
  business: [
    "sale",
    "purchase",
    "expense",
    "income",
    "credit_sale",
    "collection",
    "credit_purchase",
    "supplier_payment"
  ],
  personal: ["expense", "income"]
};

const ALL_TRANSACTION_TYPES = [
  "sale",
  "purchase",
  "expense",
  "income",
  "credit_sale",
  "collection",
  "credit_purchase",
  "supplier_payment"
];

// Credit/udhaari types and which party-role they belong to.
// `settles: true` means cash actually moves (payment in/out).
const CREDIT_TYPES = {
  credit_sale: { role: "customer", settles: false },
  collection: { role: "customer", settles: true },
  credit_purchase: { role: "supplier", settles: false },
  supplier_payment: { role: "supplier", settles: true }
};

function emptyTotals() {
  return {
    sale: 0,
    purchase: 0,
    expense: 0,
    income: 0,
    credit_sale: 0,
    collection: 0,
    credit_purchase: 0,
    supplier_payment: 0
  };
}

const app = express();
app.use(cors());
app.use(express.json());

function id(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getZonedParts(date = new Date(), timeZone = APP_TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  };
}

function localTodayIso(date = new Date(), timeZone = APP_TIMEZONE) {
  const { year, month, day } = getZonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function localMonthKey(date = new Date(), timeZone = APP_TIMEZONE) {
  const { year, month } = getZonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function shiftMonthKey(monthKey, delta) {
  const [year, month] = monthKey.split("-").map(Number);
  const shifted = new Date(year, month - 1 + delta, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
}

function isValidDateString(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
}

function isAllowedTransactionType(userType, type) {
  return ALLOWED_TRANSACTION_TYPES[userType]?.includes(type) ?? false;
}

function parseTransactionListFilters(query, userType) {
  const type = String(query.type || "").trim();
  const from = String(query.from || "").trim();
  const to = String(query.to || "").trim();
  const filters = { type: "", from: "", to: "" };

  if (type) {
    if (!ALL_TRANSACTION_TYPES.includes(type)) {
      return { error: "Invalid transaction type." };
    }
    if (userType && !isAllowedTransactionType(userType, type)) {
      return { error: "This transaction type is not available for your account." };
    }
    filters.type = type;
  }
  if (from) {
    if (!isValidDateString(from)) return { error: "From date must be YYYY-MM-DD." };
    filters.from = from;
  }
  if (to) {
    if (!isValidDateString(to)) return { error: "To date must be YYYY-MM-DD." };
    filters.to = to;
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    return { error: "From date cannot be after to date." };
  }

  return {
    filters,
    hasFilters: Boolean(filters.type || filters.from || filters.to)
  };
}

function buildSqliteListWhere({ userId, type, from, to }) {
  const parts = [];
  const params = [];
  if (userId) {
    parts.push("t.user_id = ?");
    params.push(userId);
  }
  if (type) {
    parts.push("t.type = ?");
    params.push(type);
  }
  if (from) {
    parts.push("t.date >= ?");
    params.push(from);
  }
  if (to) {
    parts.push("t.date <= ?");
    params.push(to);
  }
  return {
    whereSql: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    params
  };
}

function buildPgListWhere({ userId, type, from, to }) {
  const parts = [];
  const params = [];
  let index = 1;

  if (userId) {
    parts.push(`t.user_id = $${index++}`);
    params.push(userId);
  }
  if (type) {
    parts.push(`t.type = $${index++}`);
    params.push(type);
  }
  if (from) {
    parts.push(`t.date >= $${index++}`);
    params.push(from);
  }
  if (to) {
    parts.push(`t.date <= $${index++}`);
    params.push(to);
  }

  return {
    whereSql: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    params,
    nextIndex: index
  };
}

function toMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function requireAmount(amount) {
  const value = Number(amount);
  return Number.isFinite(value) && value > 0;
}

function normalizeEmail(email = "") {
  return email.trim().toLowerCase();
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, password_salt, ...safeUser } = user;
  return safeUser;
}

function hashPassword(password) {
  const password_salt = randomBytes(16).toString("hex");
  const password_hash = scryptSync(password, password_salt, 64).toString("hex");
  return { password_hash, password_salt };
}

function verifyPassword(password, user) {
  if (!user.password_hash || !user.password_salt) return false;
  const stored = Buffer.from(user.password_hash, "hex");
  const candidate = scryptSync(password, user.password_salt, 64);
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

function rowsToTotals(rows) {
  const totals = emptyTotals();
  for (const row of rows) {
    if (row.type in totals) totals[row.type] = toMoney(row.total);
  }
  return totals;
}

function splitAggregatedRows(rows) {
  const allTime = emptyTotals();
  const current = emptyTotals();
  const previous = emptyTotals();

  for (const row of rows) {
    if (!(row.type in allTime)) continue;
    allTime[row.type] = toMoney(row.all_time);
    current[row.type] = toMoney(row.current_month);
    previous[row.type] = toMoney(row.previous_month);
  }

  return { allTime, current, previous };
}

// Cash-basis revenue = direct cash sales + udhaari collected.
// Cash-basis cost = direct cash purchases + amounts paid to suppliers.
function recognizedSales(totals) {
  return toMoney(totals.sale + totals.collection);
}

function recognizedPurchases(totals) {
  return toMoney(totals.purchase + totals.supplier_payment);
}

function calculateDashboardFromAccount(user, balance, totals) {
  const openingBalance = toMoney(balance?.opening_balance || 0);
  const totalSales = recognizedSales(totals);
  const totalPurchases = recognizedPurchases(totals);
  const totalExpenses = totals.expense;
  const totalIncome = totals.income;
  const receivable = toMoney(totals.credit_sale - totals.collection);
  const payable = toMoney(totals.credit_purchase - totals.supplier_payment);
  const profitLoss = toMoney(totalSales - (totalPurchases + totalExpenses));
  const currentBalance =
    user.user_type === "business"
      ? toMoney(openingBalance + totalIncome + totalSales - totalPurchases - totalExpenses)
      : toMoney(openingBalance + totalIncome - totalExpenses);

  return {
    user: sanitizeUser(user),
    opening_balance: openingBalance,
    starting_balance: openingBalance,
    current_balance: currentBalance,
    remaining_money: currentBalance,
    total_sales: totalSales,
    total_purchases: totalPurchases,
    total_expenses: totalExpenses,
    total_income: totalIncome,
    total_receivable: receivable,
    total_payable: payable,
    profit_loss: profitLoss
  };
}

function monthlySummaryFromTotals(current, previous, userType = "business") {
  const currentMonthKey = localMonthKey();
  const currentSales = recognizedSales(current);
  const currentPurchases = recognizedPurchases(current);
  const previousSales = recognizedSales(previous);
  const previousPurchases = recognizedPurchases(previous);
  const currentProfit = toMoney(currentSales - (currentPurchases + current.expense));
  const previousProfit = toMoney(previousSales - (previousPurchases + previous.expense));
  const difference = toMoney(currentProfit - previousProfit);
  const netCashFlow = toMoney(current.income - current.expense);
  const isPersonal = userType === "personal";

  return {
    from: `${currentMonthKey}-01`,
    to: localTodayIso(),
    timezone: APP_TIMEZONE,
    total_sales: currentSales,
    total_purchases: currentPurchases,
    total_expenses: current.expense,
    total_income: current.income,
    total_collection: current.collection,
    total_supplier_payment: current.supplier_payment,
    net_profit_loss: isPersonal ? netCashFlow : currentProfit,
    net_cash_flow: netCashFlow,
    trend: difference > 0 ? "increase" : difference < 0 ? "decrease" : "no change",
    trend_difference: difference
  };
}

function lastThreeDaysSummaryFromTotals(totals, userType = "business") {
  const allowedDates = [
    localTodayIso(new Date(Date.now() - 2 * 86_400_000)),
    localTodayIso(new Date(Date.now() - 86_400_000)),
    localTodayIso()
  ];
  const sales = recognizedSales(totals);
  const purchases = recognizedPurchases(totals);
  const netCashFlow = toMoney(totals.income - totals.expense);
  const netProfit = toMoney(sales - (purchases + totals.expense));

  return {
    from: allowedDates[0],
    to: localTodayIso(),
    timezone: APP_TIMEZONE,
    total_sales: sales,
    total_purchases: purchases,
    total_expenses: totals.expense,
    total_income: totals.income,
    net_profit_loss: userType === "personal" ? netCashFlow : netProfit,
    net_cash_flow: netCashFlow
  };
}

async function buildAccountMetrics(store, userId) {
  const user = await store.findUserById(userId);
  if (!user) return null;

  const balance = await store.getBalance(userId);
  const currentMonthKey = localMonthKey();
  const previousMonthKey = shiftMonthKey(currentMonthKey, -1);
  const aggregated = await store.getAggregatedTotals(userId, user.user_type, {
    currentMonthKey,
    previousMonthKey
  });
  const { allTime, current, previous } = splitAggregatedRows(aggregated);

  return {
    user,
    balance,
    dashboard: calculateDashboardFromAccount(user, balance, allTime),
    summary: monthlySummaryFromTotals(current, previous, user.user_type)
  };
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function createSqliteStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(SQLITE_FILE);
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      user_type TEXT NOT NULL CHECK (user_type IN ('business', 'personal')),
      password_hash TEXT,
      password_salt TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS balances (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      opening_balance REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN (
        'sale', 'purchase', 'expense', 'income',
        'credit_sale', 'collection', 'credit_purchase', 'supplier_payment'
      )),
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      party_id TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS parties (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL CHECK (role IN ('customer', 'supplier')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_user_date
      ON transactions(user_id, date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_parties_user
      ON parties(user_id, role);
  `);

  // Add party_id to older transactions tables (must happen before any
  // index on party_id is created).
  try {
    sqlite.exec("ALTER TABLE transactions ADD COLUMN party_id TEXT");
  } catch {
    // Column already exists.
  }

  const transactionTable = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'")
    .get();
  if (transactionTable?.sql && !transactionTable.sql.includes("'credit_sale'")) {
    // Rebuild to widen the type CHECK. Base columns only are copied; older
    // rows never had a party, so party_id stays NULL.
    sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS transactions_old;
      ALTER TABLE transactions RENAME TO transactions_old;

      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN (
          'sale', 'purchase', 'expense', 'income',
          'credit_sale', 'collection', 'credit_purchase', 'supplier_payment'
        )),
        amount REAL NOT NULL,
        description TEXT NOT NULL,
        date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        party_id TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      INSERT INTO transactions (id, user_id, type, amount, description, date, created_at)
      SELECT id, user_id, type, amount, description, date, created_at
      FROM transactions_old;

      DROP TABLE transactions_old;
      PRAGMA foreign_keys = ON;
    `);
  }

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_user_date
      ON transactions(user_id, date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_party
      ON transactions(party_id);
  `);

  function migrateLegacyJson() {
    if (!existsSync(LEGACY_JSON_FILE)) return;
    const existingUsers = sqlite.prepare("SELECT COUNT(*) AS total FROM users").get().total;
    if (existingUsers > 0) return;

    const legacy = JSON.parse(readFileSync(LEGACY_JSON_FILE, "utf8") || "{}");
    const users = Array.isArray(legacy.users) ? legacy.users : [];
    const balances = Array.isArray(legacy.balances) ? legacy.balances : [];
    const transactions = Array.isArray(legacy.transactions) ? legacy.transactions : [];

    const insertUser = sqlite.prepare(`
      INSERT INTO users (id, name, email, user_type, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBalance = sqlite.prepare(`
      INSERT INTO balances (id, user_id, opening_balance)
      VALUES (?, ?, ?)
    `);
    const insertTransaction = sqlite.prepare(`
      INSERT INTO transactions (id, user_id, type, amount, description, date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    sqlite.exec("BEGIN");
    try {
      for (const user of users) {
        insertUser.run(
          user.id,
          user.name,
          normalizeEmail(user.email),
          user.user_type,
          user.password_hash || null,
          user.password_salt || null,
          user.created_at || new Date().toISOString()
        );
      }
      for (const balance of balances) {
        insertBalance.run(balance.id, balance.user_id, toMoney(balance.opening_balance));
      }
      for (const transaction of transactions) {
        insertTransaction.run(
          transaction.id,
          transaction.user_id,
          transaction.type,
          toMoney(transaction.amount),
          transaction.description || "Migrated entry",
          transaction.date,
          transaction.created_at || new Date().toISOString()
        );
      }
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  migrateLegacyJson();

  return {
    kind: "sqlite",
    async findUserById(userId) {
      return sqlite.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    },
    async findUserByEmail(email) {
      return sqlite.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
    },
    async createUser(user, balance) {
      sqlite
        .prepare(
          `INSERT INTO users (id, name, email, user_type, password_hash, password_salt, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          user.id,
          user.name,
          user.email,
          user.user_type,
          user.password_hash,
          user.password_salt,
          user.created_at
        );
      sqlite
        .prepare("INSERT INTO balances (id, user_id, opening_balance) VALUES (?, ?, ?)")
        .run(balance.id, balance.user_id, balance.opening_balance);
    },
    async getBalance(userId) {
      return sqlite.prepare("SELECT * FROM balances WHERE user_id = ?").get(userId);
    },
    async getAggregatedTotals(userId, userType, { currentMonthKey, previousMonthKey }) {
      const types = ALLOWED_TRANSACTION_TYPES[userType];
      const placeholders = types.map(() => "?").join(", ");
      return sqlite
        .prepare(
          `SELECT type,
                  SUM(amount) AS all_time,
                  SUM(CASE WHEN substr(date, 1, 7) = ? THEN amount ELSE 0 END) AS current_month,
                  SUM(CASE WHEN substr(date, 1, 7) = ? THEN amount ELSE 0 END) AS previous_month
           FROM transactions
           WHERE user_id = ?
             AND type IN (${placeholders})
             AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
           GROUP BY type`
        )
        .all(currentMonthKey, previousMonthKey, userId, ...types);
    },
    async getRecentTotals(userId, userType, dates) {
      const types = ALLOWED_TRANSACTION_TYPES[userType];
      const typePlaceholders = types.map(() => "?").join(", ");
      const datePlaceholders = dates.map(() => "?").join(", ");
      const rows = sqlite
        .prepare(
          `SELECT type, SUM(amount) AS total
           FROM transactions
           WHERE user_id = ?
             AND type IN (${typePlaceholders})
             AND date IN (${datePlaceholders})
             AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
           GROUP BY type`
        )
        .all(userId, ...types, ...dates);
      return rowsToTotals(rows);
    },
    async addTransaction(transaction) {
      sqlite
        .prepare(
          `INSERT INTO transactions (id, user_id, type, amount, description, date, created_at, party_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          transaction.id,
          transaction.user_id,
          transaction.type,
          transaction.amount,
          transaction.description,
          transaction.date,
          transaction.created_at,
          transaction.party_id || null
        );
    },
    async deleteTransaction({ userId, transactionId }) {
      const transaction = sqlite
        .prepare("SELECT * FROM transactions WHERE id = ? AND user_id = ?")
        .get(transactionId, userId);
      if (!transaction) return null;

      sqlite.prepare("DELETE FROM transactions WHERE id = ? AND user_id = ?").run(transactionId, userId);
      return transaction;
    },
    async listTransactions({ userId, page, limit, type = "", from = "", to = "" }) {
      const { whereSql, params } = buildSqliteListWhere({ userId, type, from, to });
      const baseSelect = `
        SELECT t.*, p.name AS party_name
        FROM transactions t
        LEFT JOIN parties p ON p.id = t.party_id
        ${whereSql}
      `;

      if (page > 0 && limit > 0) {
        const safeLimit = Math.min(Math.max(limit, 1), 50);
        const total = sqlite
          .prepare(`SELECT COUNT(*) AS total FROM transactions t ${whereSql}`)
          .get(...params).total;
        const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
        const safePage = Math.min(Math.max(page, 1), totalPages);
        const offset = (safePage - 1) * safeLimit;
        const items = sqlite
          .prepare(
            `${baseSelect}
             ORDER BY t.date DESC, t.created_at DESC
             LIMIT ? OFFSET ?`
          )
          .all(...params, safeLimit, offset);
        return { items, page: safePage, limit: safeLimit, total, total_pages: totalPages };
      }

      return sqlite
        .prepare(`${baseSelect} ORDER BY t.date DESC, t.created_at DESC`)
        .all(...params);
    },
    async createParty(party) {
      sqlite
        .prepare(
          `INSERT INTO parties (id, user_id, name, phone, role, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(party.id, party.user_id, party.name, party.phone || null, party.role, party.created_at);
    },
    async findParty(userId, partyId) {
      return sqlite
        .prepare("SELECT * FROM parties WHERE id = ? AND user_id = ?")
        .get(partyId, userId);
    },
    async findPartyByName(userId, role, name) {
      return sqlite
        .prepare(
          "SELECT * FROM parties WHERE user_id = ? AND role = ? AND lower(name) = lower(?)"
        )
        .get(userId, role, name);
    },
    async listParties(userId, role) {
      const params = [userId];
      let roleSql = "";
      if (role) {
        roleSql = "AND p.role = ?";
        params.push(role);
      }
      return sqlite
        .prepare(
          `SELECT p.*,
                  COALESCE(SUM(CASE WHEN t.type = 'credit_sale' THEN t.amount
                                    WHEN t.type = 'collection' THEN -t.amount ELSE 0 END), 0) AS receivable,
                  COALESCE(SUM(CASE WHEN t.type = 'credit_purchase' THEN t.amount
                                    WHEN t.type = 'supplier_payment' THEN -t.amount ELSE 0 END), 0) AS payable
           FROM parties p
           LEFT JOIN transactions t ON t.party_id = p.id AND t.user_id = p.user_id
           WHERE p.user_id = ? ${roleSql}
           GROUP BY p.id
           ORDER BY p.name COLLATE NOCASE`
        )
        .all(...params);
    },
    async getPartyOutstanding(userId, partyId) {
      const row = sqlite
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN type = 'credit_sale' THEN amount
                               WHEN type = 'collection' THEN -amount ELSE 0 END), 0) AS receivable,
             COALESCE(SUM(CASE WHEN type = 'credit_purchase' THEN amount
                               WHEN type = 'supplier_payment' THEN -amount ELSE 0 END), 0) AS payable
           FROM transactions
           WHERE user_id = ? AND party_id = ?`
        )
        .get(userId, partyId);
      return { receivable: toMoney(row.receivable), payable: toMoney(row.payable) };
    },
    async getPartyLedger(userId, partyId) {
      return sqlite
        .prepare(
          "SELECT * FROM transactions WHERE user_id = ? AND party_id = ? ORDER BY date DESC, created_at DESC"
        )
        .all(userId, partyId);
    },
  };
}

async function createPostgresStore() {
  const { Pool } = await import("pg");
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: process.env.VERCEL ? 1 : 10,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      user_type TEXT NOT NULL CHECK (user_type IN ('business', 'personal')),
      password_hash TEXT,
      password_salt TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS balances (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      opening_balance DOUBLE PRECISION NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN (
        'sale', 'purchase', 'expense', 'income',
        'credit_sale', 'collection', 'credit_purchase', 'supplier_payment'
      )),
      amount DOUBLE PRECISION NOT NULL,
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      party_id TEXT
    );

    CREATE TABLE IF NOT EXISTS parties (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL CHECK (role IN ('customer', 'supplier')),
      created_at TEXT NOT NULL
    );

    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS party_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_transactions_user_date
      ON transactions(user_id, date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_party
      ON transactions(party_id);
    CREATE INDEX IF NOT EXISTS idx_parties_user
      ON parties(user_id, role);
  `);

  await pool.query(`
    DO $$
    DECLARE
      constraint_name text;
    BEGIN
      SELECT con.conname INTO constraint_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = con.connamespace
      WHERE rel.relname = 'transactions'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) LIKE '%type%';

      IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE transactions DROP CONSTRAINT %I', constraint_name);
      END IF;

      ALTER TABLE transactions
        ADD CONSTRAINT transactions_type_check
        CHECK (type IN (
          'sale', 'purchase', 'expense', 'income',
          'credit_sale', 'collection', 'credit_purchase', 'supplier_payment'
        ));
    EXCEPTION
      WHEN duplicate_object THEN
        NULL;
    END $$;
  `);

  return {
    kind: "postgres",
    async findUserById(userId) {
      const result = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
      return result.rows[0] || null;
    },
    async findUserByEmail(email) {
      const result = await pool.query("SELECT * FROM users WHERE email = $1", [
        normalizeEmail(email)
      ]);
      return result.rows[0] || null;
    },
    async createUser(user, balance) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO users (id, name, email, user_type, password_hash, password_salt, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            user.id,
            user.name,
            user.email,
            user.user_type,
            user.password_hash,
            user.password_salt,
            user.created_at
          ]
        );
        await client.query(
          "INSERT INTO balances (id, user_id, opening_balance) VALUES ($1, $2, $3)",
          [balance.id, balance.user_id, balance.opening_balance]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async getBalance(userId) {
      const result = await pool.query("SELECT * FROM balances WHERE user_id = $1", [userId]);
      return result.rows[0];
    },
    async getAggregatedTotals(userId, userType, { currentMonthKey, previousMonthKey }) {
      const types = ALLOWED_TRANSACTION_TYPES[userType];
      const result = await pool.query(
        `SELECT type,
                COALESCE(SUM(amount), 0) AS all_time,
                COALESCE(SUM(CASE WHEN left(date, 7) = $3 THEN amount ELSE 0 END), 0) AS current_month,
                COALESCE(SUM(CASE WHEN left(date, 7) = $4 THEN amount ELSE 0 END), 0) AS previous_month
         FROM transactions
         WHERE user_id = $1
           AND type = ANY($2::text[])
         GROUP BY type`,
        [userId, types, currentMonthKey, previousMonthKey]
      );
      return result.rows;
    },
    async getRecentTotals(userId, userType, dates) {
      const types = ALLOWED_TRANSACTION_TYPES[userType];
      const result = await pool.query(
        `SELECT type, COALESCE(SUM(amount), 0) AS total
         FROM transactions
         WHERE user_id = $1
           AND type = ANY($2::text[])
           AND date = ANY($3::text[])
         GROUP BY type`,
        [userId, types, dates]
      );
      return rowsToTotals(result.rows);
    },
    async addTransaction(transaction) {
      await pool.query(
        `INSERT INTO transactions (id, user_id, type, amount, description, date, created_at, party_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          transaction.id,
          transaction.user_id,
          transaction.type,
          transaction.amount,
          transaction.description,
          transaction.date,
          transaction.created_at,
          transaction.party_id || null
        ]
      );
    },
    async deleteTransaction({ userId, transactionId }) {
      const result = await pool.query(
        "DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING *",
        [transactionId, userId]
      );
      return result.rows[0] || null;
    },
    async listTransactions({ userId, page, limit, type = "", from = "", to = "" }) {
      const { whereSql, params, nextIndex } = buildPgListWhere({ userId, type, from, to });
      const baseSelect = `
        SELECT t.*, p.name AS party_name
        FROM transactions t
        LEFT JOIN parties p ON p.id = t.party_id
        ${whereSql}
      `;

      if (page > 0 && limit > 0) {
        const safeLimit = Math.min(Math.max(limit, 1), 50);
        const totalResult = await pool.query(
          `SELECT COUNT(*)::int AS total FROM transactions t ${whereSql}`,
          params
        );
        const total = totalResult.rows[0].total;
        const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
        const safePage = Math.min(Math.max(page, 1), totalPages);
        const offset = (safePage - 1) * safeLimit;
        const itemResult = await pool.query(
          `${baseSelect}
           ORDER BY t.date DESC, t.created_at DESC
           LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
          [...params, safeLimit, offset]
        );
        return {
          items: itemResult.rows,
          page: safePage,
          limit: safeLimit,
          total,
          total_pages: totalPages
        };
      }

      const result = await pool.query(
        `${baseSelect} ORDER BY t.date DESC, t.created_at DESC`,
        params
      );
      return result.rows;
    },
    async createParty(party) {
      await pool.query(
        `INSERT INTO parties (id, user_id, name, phone, role, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [party.id, party.user_id, party.name, party.phone || null, party.role, party.created_at]
      );
    },
    async findParty(userId, partyId) {
      const result = await pool.query(
        "SELECT * FROM parties WHERE id = $1 AND user_id = $2",
        [partyId, userId]
      );
      return result.rows[0] || null;
    },
    async findPartyByName(userId, role, name) {
      const result = await pool.query(
        "SELECT * FROM parties WHERE user_id = $1 AND role = $2 AND lower(name) = lower($3)",
        [userId, role, name]
      );
      return result.rows[0] || null;
    },
    async listParties(userId, role) {
      const params = [userId];
      let roleSql = "";
      if (role) {
        roleSql = "AND p.role = $2";
        params.push(role);
      }
      const result = await pool.query(
        `SELECT p.*,
                COALESCE(SUM(CASE WHEN t.type = 'credit_sale' THEN t.amount
                                  WHEN t.type = 'collection' THEN -t.amount ELSE 0 END), 0) AS receivable,
                COALESCE(SUM(CASE WHEN t.type = 'credit_purchase' THEN t.amount
                                  WHEN t.type = 'supplier_payment' THEN -t.amount ELSE 0 END), 0) AS payable
         FROM parties p
         LEFT JOIN transactions t ON t.party_id = p.id AND t.user_id = p.user_id
         WHERE p.user_id = $1 ${roleSql}
         GROUP BY p.id
         ORDER BY lower(p.name)`,
        params
      );
      return result.rows;
    },
    async getPartyOutstanding(userId, partyId) {
      const result = await pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type = 'credit_sale' THEN amount
                             WHEN type = 'collection' THEN -amount ELSE 0 END), 0) AS receivable,
           COALESCE(SUM(CASE WHEN type = 'credit_purchase' THEN amount
                             WHEN type = 'supplier_payment' THEN -amount ELSE 0 END), 0) AS payable
         FROM transactions
         WHERE user_id = $1 AND party_id = $2`,
        [userId, partyId]
      );
      const row = result.rows[0] || { receivable: 0, payable: 0 };
      return { receivable: toMoney(row.receivable), payable: toMoney(row.payable) };
    },
    async getPartyLedger(userId, partyId) {
      const result = await pool.query(
        "SELECT * FROM transactions WHERE user_id = $1 AND party_id = $2 ORDER BY date DESC, created_at DESC",
        [userId, partyId]
      );
      return result.rows;
    },
  };
}

function createMissingDatabaseStore() {
  const error = new Error(
    "DATABASE_URL is not configured. Add Neon/Postgres to this Vercel project."
  );
  error.statusCode = 503;

  return {
    kind: "missing",
    async findUserById() {
      throw error;
    },
    async findUserByEmail() {
      throw error;
    },
    async createUser() {
      throw error;
    },
    async getBalance() {
      throw error;
    },
    async getAggregatedTotals() {
      throw error;
    },
    async getRecentTotals() {
      throw error;
    },
    async addTransaction() {
      throw error;
    },
    async deleteTransaction() {
      throw error;
    },
    async listTransactions() {
      throw error;
    },
    async createParty() {
      throw error;
    },
    async findParty() {
      throw error;
    },
    async findPartyByName() {
      throw error;
    },
    async listParties() {
      throw error;
    },
    async getPartyOutstanding() {
      throw error;
    },
    async getPartyLedger() {
      throw error;
    },
  };
}

const store = DATABASE_URL
  ? await createPostgresStore()
  : process.env.VERCEL
    ? createMissingDatabaseStore()
    : await createSqliteStore();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: store.kind !== "missing",
    database: store.kind,
    has_database_url: Boolean(DATABASE_URL)
  });
});

async function createUser(req, res, { requirePassword }) {
  const { name, email = "", password = "", user_type, opening_balance = 0 } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!name?.trim()) {
    return res.status(400).json({ error: "Name is required." });
  }
  if (!normalizedEmail) {
    return res.status(400).json({ error: "Email is required." });
  }
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: "Enter a valid email." });
  }
  if (requirePassword && password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }
  if (!["business", "personal"].includes(user_type)) {
    return res.status(400).json({ error: "User type must be business or personal." });
  }
  if (Number(opening_balance) < 0) {
    return res.status(400).json({ error: "Opening balance cannot be negative." });
  }
  if (await store.findUserByEmail(normalizedEmail)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const passwordFields = password ? hashPassword(password) : {};
  const user = {
    id: id("usr"),
    name: name.trim(),
    email: normalizedEmail,
    user_type,
    password_hash: passwordFields.password_hash || null,
    password_salt: passwordFields.password_salt || null,
    created_at: new Date().toISOString()
  };
  const balance = {
    id: id("bal"),
    user_id: user.id,
    opening_balance: toMoney(opening_balance)
  };

  await store.createUser(user, balance);

  res.status(201).json({ user: sanitizeUser(user), balance });
}


app.post("/api/auth/signup", (req, res, next) =>
  createUser(req, res, { requirePassword: true }).catch(next)
);

app.post("/api/create-user", (req, res, next) => {
  if (!ALLOW_CREATE_USER) {
    return res.status(404).json({ error: "Not found." });
  }
  createUser(req, res, { requirePassword: false }).catch(next);
});

app.post("/api/auth/login", async (req, res) => {
  const { email = "", password = "" } = req.body;
  const user = await store.findUserByEmail(email);

  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  res.json({ user: sanitizeUser(user) });
});

app.post("/api/transaction/add", async (req, res) => {
  const { user_id, type, amount, description = "", date = localTodayIso() } = req.body;
  let cleanDescription = description.trim();
  const entryDate = String(date).trim();

  if (!user_id) return res.status(400).json({ error: "user_id is required." });
  if (!ALL_TRANSACTION_TYPES.includes(type)) {
    return res.status(400).json({ error: "Invalid transaction type." });
  }
  if (!requireAmount(amount)) {
    return res.status(400).json({ error: "Amount must be greater than 0." });
  }
  // Payment entries (in/out) can default their description; goods entries cannot.
  if (!cleanDescription) {
    if (type === "collection") cleanDescription = "Payment received";
    else if (type === "supplier_payment") cleanDescription = "Payment paid";
    else return res.status(400).json({ error: "Description is required." });
  }
  if (!isValidDateString(entryDate)) {
    return res.status(400).json({ error: "Date must be YYYY-MM-DD." });
  }

  const user = await store.findUserById(user_id);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (!isAllowedTransactionType(user.user_type, type)) {
    return res.status(400).json({
      error:
        user.user_type === "personal"
          ? "Personal accounts can only add expense or income entries."
          : "This transaction type is not allowed for this account."
    });
  }

  let partyId = null;
  const creditMeta = CREDIT_TYPES[type];
  if (creditMeta) {
    const requestedPartyId = String(req.body.party_id || "").trim();
    if (!requestedPartyId) {
      return res.status(400).json({
        error: creditMeta.role === "customer" ? "Select a customer." : "Select a supplier."
      });
    }
    const party = await store.findParty(user_id, requestedPartyId);
    if (!party) return res.status(404).json({ error: "Party not found." });
    if (party.role !== creditMeta.role) {
      return res.status(400).json({
        error: `This entry needs a ${creditMeta.role}, not a ${party.role}.`
      });
    }
    partyId = party.id;

    // Block paying/collecting more than what is outstanding (no advances).
    if (creditMeta.settles) {
      const outstanding = await store.getPartyOutstanding(user_id, partyId);
      const due = type === "collection" ? outstanding.receivable : outstanding.payable;
      if (toMoney(amount) > toMoney(due)) {
        return res.status(400).json({
          error:
            due <= 0
              ? "Nothing is outstanding for this party."
              : `Amount cannot exceed the outstanding ₹${toMoney(due)}.`
        });
      }
    }
  }

  const transaction = {
    id: id("txn"),
    user_id,
    type,
    amount: toMoney(amount),
    description: cleanDescription,
    date: entryDate,
    created_at: new Date().toISOString(),
    party_id: partyId
  };

  await store.addTransaction(transaction);

  const metrics = await buildAccountMetrics(store, user_id);
  res.status(201).json({
    transaction,
    dashboard: metrics.dashboard,
    summary: metrics.summary
  });
});

app.post("/api/transaction/delete", async (req, res) => {
  const { user_id, transaction_id } = req.body;

  if (!user_id) return res.status(400).json({ error: "user_id is required." });
  if (!transaction_id) return res.status(400).json({ error: "transaction_id is required." });

  const deleted = await store.deleteTransaction({ userId: user_id, transactionId: transaction_id });
  if (!deleted) return res.status(404).json({ error: "Transaction not found." });

  const metrics = await buildAccountMetrics(store, user_id);
  if (!metrics) return res.status(404).json({ error: "User not found." });

  res.json({
    deleted,
    dashboard: metrics.dashboard,
    summary: metrics.summary
  });
});

app.get(
  "/api/transactions/list",
  asyncRoute(async (req, res) => {
    if (!req.query.user_id) {
      return res.status(400).json({ error: "user_id is required." });
    }

    const user = await store.findUserById(req.query.user_id);
    if (!user) return res.status(404).json({ error: "User not found." });

    const parsed = parseTransactionListFilters(req.query, user.user_type);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const transactions = await store.listTransactions({
      userId: req.query.user_id,
      page: Number(req.query.page || 0),
      limit: Number(req.query.limit || 0),
      type: parsed.filters.type,
      from: parsed.filters.from,
      to: parsed.filters.to
    });

    res.json({
      ...transactions,
      filters: parsed.filters,
      filtered: parsed.hasFilters
    });
  })
);

app.get(
  "/api/parties",
  asyncRoute(async (req, res) => {
    if (!req.query.user_id) {
      return res.status(400).json({ error: "user_id is required." });
    }
    const user = await store.findUserById(req.query.user_id);
    if (!user) return res.status(404).json({ error: "User not found." });

    const role = String(req.query.role || "").trim();
    if (role && !["customer", "supplier"].includes(role)) {
      return res.status(400).json({ error: "Invalid role." });
    }

    const rows = await store.listParties(req.query.user_id, role || null);
    const items = rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone || "",
      role: row.role,
      created_at: row.created_at,
      receivable: toMoney(row.receivable),
      payable: toMoney(row.payable),
      outstanding: toMoney(row.role === "supplier" ? row.payable : row.receivable)
    }));
    res.json({ items });
  })
);

app.post(
  "/api/parties",
  asyncRoute(async (req, res) => {
    const { user_id, name = "", phone = "", role } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id is required." });

    const user = await store.findUserById(user_id);
    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.user_type !== "business") {
      return res.status(400).json({ error: "Only business accounts can keep a khata." });
    }

    const cleanName = String(name).trim();
    if (!cleanName) return res.status(400).json({ error: "Name is required." });
    if (!["customer", "supplier"].includes(role)) {
      return res.status(400).json({ error: "Role must be customer or supplier." });
    }

    const existing = await store.findPartyByName(user_id, role, cleanName);
    if (existing) {
      return res.status(409).json({ error: `A ${role} with this name already exists.` });
    }

    const party = {
      id: id("pty"),
      user_id,
      name: cleanName,
      phone: String(phone || "").trim(),
      role,
      created_at: new Date().toISOString()
    };
    await store.createParty(party);
    res.status(201).json({ party: { ...party, receivable: 0, payable: 0, outstanding: 0 } });
  })
);

app.get(
  "/api/parties/ledger",
  asyncRoute(async (req, res) => {
    if (!req.query.user_id) {
      return res.status(400).json({ error: "user_id is required." });
    }
    if (!req.query.party_id) {
      return res.status(400).json({ error: "party_id is required." });
    }

    const party = await store.findParty(req.query.user_id, req.query.party_id);
    if (!party) return res.status(404).json({ error: "Party not found." });

    const outstanding = await store.getPartyOutstanding(req.query.user_id, req.query.party_id);
    const transactions = await store.getPartyLedger(req.query.user_id, req.query.party_id);

    res.json({
      party: {
        id: party.id,
        name: party.name,
        phone: party.phone || "",
        role: party.role,
        created_at: party.created_at,
        receivable: outstanding.receivable,
        payable: outstanding.payable,
        outstanding: party.role === "supplier" ? outstanding.payable : outstanding.receivable
      },
      transactions
    });
  })
);

app.get(
  "/api/account/overview",
  asyncRoute(async (req, res) => {
    if (!req.query.user_id) {
      return res.status(400).json({ error: "user_id is required." });
    }

    const metrics = await buildAccountMetrics(store, req.query.user_id);
    if (!metrics) return res.status(404).json({ error: "User not found." });

    res.json({
      dashboard: metrics.dashboard,
      summary: metrics.summary
    });
  })
);

app.get(
  "/api/dashboard/business",
  asyncRoute(async (req, res) => {
    const metrics = await buildAccountMetrics(store, req.query.user_id);
    if (!metrics) return res.status(404).json({ error: "User not found." });
    if (metrics.user.user_type !== "business") {
      return res.status(400).json({ error: "User is not a business user." });
    }

    res.json(metrics.dashboard);
  })
);

app.get(
  "/api/dashboard/personal",
  asyncRoute(async (req, res) => {
    const metrics = await buildAccountMetrics(store, req.query.user_id);
    if (!metrics) return res.status(404).json({ error: "User not found." });
    if (metrics.user.user_type !== "personal") {
      return res.status(400).json({ error: "User is not a personal user." });
    }

    res.json(metrics.dashboard);
  })
);

app.get(
  "/api/summary/month",
  asyncRoute(async (req, res) => {
    const metrics = await buildAccountMetrics(store, req.query.user_id);
    if (!metrics) return res.status(404).json({ error: "User not found." });

    res.json(metrics.summary);
  })
);

app.get("/api/summary/last-3-days", async (req, res) => {
  const user = await store.findUserById(req.query.user_id);
  if (!user) return res.status(404).json({ error: "User not found." });

  const dates = [
    localTodayIso(),
    localTodayIso(new Date(Date.now() - 86_400_000)),
    localTodayIso(new Date(Date.now() - 2 * 86_400_000))
  ];
  const totals = await store.getRecentTotals(user.id, user.user_type, dates);
  res.json(lastThreeDaysSummaryFromTotals(totals, user.user_type));
});

app.get("/api/users/me", async (req, res) => {
  const user = await store.findUserById(req.query.user_id);
  if (!user) return res.status(404).json({ error: "User not found." });

  res.json({ user: sanitizeUser(user) });
});

app.get("/api/users", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  res.status(error.statusCode || 500).json({
    error: error.message || "Server error.",
    code: error.code || undefined
  });
});

export default app;

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isDirectRun) {
  const keepAlive = setInterval(() => {}, 1 << 30);
  const server = app.listen(PORT, () => {
    console.log(`Daily Money Flow API running on http://localhost:${PORT}`);
    console.log(
      store.kind === "postgres"
        ? "Database: Postgres"
        : `SQLite database: ${SQLITE_FILE}`
    );
  });

  process.on("SIGTERM", () => {
    clearInterval(keepAlive);
    server.close(() => process.exit(0));
  });
}
