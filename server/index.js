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
  business: ["sale", "purchase", "expense", "income"],
  personal: ["expense", "income"]
};

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
  const totals = { sale: 0, purchase: 0, expense: 0, income: 0 };
  for (const row of rows) {
    if (row.type in totals) totals[row.type] = toMoney(row.total);
  }
  return totals;
}

function splitAggregatedRows(rows) {
  const allTime = { sale: 0, purchase: 0, expense: 0, income: 0 };
  const current = { sale: 0, purchase: 0, expense: 0, income: 0 };
  const previous = { sale: 0, purchase: 0, expense: 0, income: 0 };

  for (const row of rows) {
    if (!(row.type in allTime)) continue;
    allTime[row.type] = toMoney(row.all_time);
    current[row.type] = toMoney(row.current_month);
    previous[row.type] = toMoney(row.previous_month);
  }

  return { allTime, current, previous };
}

function calculateDashboardFromAccount(user, balance, totals) {
  const openingBalance = toMoney(balance?.opening_balance || 0);
  const totalSales = totals.sale;
  const totalPurchases = totals.purchase;
  const totalExpenses = totals.expense;
  const totalIncome = totals.income;
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
    profit_loss: profitLoss
  };
}

function monthlySummaryFromTotals(current, previous, userType = "business") {
  const currentMonthKey = localMonthKey();
  const currentProfit = toMoney(current.sale - (current.purchase + current.expense));
  const previousProfit = toMoney(previous.sale - (previous.purchase + previous.expense));
  const difference = toMoney(currentProfit - previousProfit);
  const netCashFlow = toMoney(current.income - current.expense);
  const isPersonal = userType === "personal";

  return {
    from: `${currentMonthKey}-01`,
    to: localTodayIso(),
    timezone: APP_TIMEZONE,
    total_sales: current.sale,
    total_purchases: current.purchase,
    total_expenses: current.expense,
    total_income: current.income,
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
  const netCashFlow = toMoney(totals.income - totals.expense);
  const netProfit = toMoney(totals.sale - (totals.purchase + totals.expense));

  return {
    from: allowedDates[0],
    to: localTodayIso(),
    timezone: APP_TIMEZONE,
    total_sales: totals.sale,
    total_purchases: totals.purchase,
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
      type TEXT NOT NULL CHECK (type IN ('sale', 'purchase', 'expense', 'income')),
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_user_date
      ON transactions(user_id, date DESC, created_at DESC);
  `);

  const transactionTable = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'")
    .get();
  if (transactionTable?.sql && !transactionTable.sql.includes("'income'")) {
    sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE transactions RENAME TO transactions_old;

      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('sale', 'purchase', 'expense', 'income')),
        amount REAL NOT NULL,
        description TEXT NOT NULL,
        date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      INSERT INTO transactions (id, user_id, type, amount, description, date, created_at)
      SELECT id, user_id, type, amount, description, date, created_at
      FROM transactions_old;

      DROP TABLE transactions_old;
      PRAGMA foreign_keys = ON;

      CREATE INDEX IF NOT EXISTS idx_transactions_user_date
        ON transactions(user_id, date DESC, created_at DESC);
    `);
  }

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
          `INSERT INTO transactions (id, user_id, type, amount, description, date, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          transaction.id,
          transaction.user_id,
          transaction.type,
          transaction.amount,
          transaction.description,
          transaction.date,
          transaction.created_at
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
    async listTransactions({ userId, page, limit }) {
      const whereSql = userId ? "WHERE user_id = ?" : "";
      const params = userId ? [userId] : [];

      if (page > 0 && limit > 0) {
        const safeLimit = Math.min(Math.max(limit, 1), 50);
        const total = sqlite
          .prepare(`SELECT COUNT(*) AS total FROM transactions ${whereSql}`)
          .get(...params).total;
        const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
        const safePage = Math.min(Math.max(page, 1), totalPages);
        const offset = (safePage - 1) * safeLimit;
        const items = sqlite
          .prepare(
            `SELECT * FROM transactions ${whereSql}
             ORDER BY date DESC, created_at DESC
             LIMIT ? OFFSET ?`
          )
          .all(...params, safeLimit, offset);
        return { items, page: safePage, limit: safeLimit, total, total_pages: totalPages };
      }

      return sqlite
        .prepare(`SELECT * FROM transactions ${whereSql} ORDER BY date DESC, created_at DESC`)
        .all(...params);
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
      type TEXT NOT NULL CHECK (type IN ('sale', 'purchase', 'expense', 'income')),
      amount DOUBLE PRECISION NOT NULL,
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_user_date
      ON transactions(user_id, date DESC, created_at DESC);
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
        CHECK (type IN ('sale', 'purchase', 'expense', 'income'));
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
        `INSERT INTO transactions (id, user_id, type, amount, description, date, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          transaction.id,
          transaction.user_id,
          transaction.type,
          transaction.amount,
          transaction.description,
          transaction.date,
          transaction.created_at
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
    async listTransactions({ userId, page, limit }) {
      const params = [];
      const whereSql = userId ? "WHERE user_id = $1" : "";
      if (userId) params.push(userId);

      if (page > 0 && limit > 0) {
        const safeLimit = Math.min(Math.max(limit, 1), 50);
        const totalResult = await pool.query(
          `SELECT COUNT(*)::int AS total FROM transactions ${whereSql}`,
          params
        );
        const total = totalResult.rows[0].total;
        const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
        const safePage = Math.min(Math.max(page, 1), totalPages);
        const offset = (safePage - 1) * safeLimit;
        const itemResult = await pool.query(
          `SELECT * FROM transactions ${whereSql}
           ORDER BY date DESC, created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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
        `SELECT * FROM transactions ${whereSql} ORDER BY date DESC, created_at DESC`,
        params
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
  const cleanDescription = description.trim();
  const entryDate = String(date).trim();

  if (!user_id) return res.status(400).json({ error: "user_id is required." });
  if (!["sale", "purchase", "expense", "income"].includes(type)) {
    return res.status(400).json({ error: "Type must be sale, purchase, expense, or income." });
  }
  if (!requireAmount(amount)) {
    return res.status(400).json({ error: "Amount must be greater than 0." });
  }
  if (!cleanDescription) {
    return res.status(400).json({ error: "Description is required." });
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

  const transaction = {
    id: id("txn"),
    user_id,
    type,
    amount: toMoney(amount),
    description: cleanDescription,
    date: entryDate,
    created_at: new Date().toISOString()
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

app.get("/api/transactions/list", async (req, res) => {
  if (!req.query.user_id) {
    return res.status(400).json({ error: "user_id is required." });
  }

  const transactions = await store.listTransactions({
    userId: req.query.user_id,
    page: Number(req.query.page || 0),
    limit: Number(req.query.limit || 0)
  });
  res.json(transactions);
});

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
