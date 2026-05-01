import cors from "cors";
import express from "express";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const SQLITE_FILE = join(DATA_DIR, "money-tracker.sqlite");
const LEGACY_JSON_FILE = join(DATA_DIR, "db.json");
const PORT = process.env.PORT || 4000;

mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(SQLITE_FILE);
db.exec(`
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
    type TEXT NOT NULL CHECK (type IN ('sale', 'purchase', 'expense')),
    amount REAL NOT NULL,
    description TEXT NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_user_date
    ON transactions(user_id, date DESC, created_at DESC);
`);

const app = express();
app.use(cors());
app.use(express.json());

function id(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
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

function getUserById(userId) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
}

function getBalance(userId) {
  return db.prepare("SELECT * FROM balances WHERE user_id = ?").get(userId);
}

function getTransactions(userId) {
  return db
    .prepare(
      "SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, created_at DESC"
    )
    .all(userId);
}

function getUserBundle(userId) {
  const user = getUserById(userId);
  if (!user) return null;

  return {
    user,
    balance: getBalance(userId),
    transactions: getTransactions(userId)
  };
}

function calculateDashboard(bundle) {
  const openingBalance = toMoney(bundle.balance?.opening_balance || 0);
  const totals = bundle.transactions.reduce(
    (acc, txn) => {
      acc[txn.type] += Number(txn.amount);
      return acc;
    },
    { sale: 0, purchase: 0, expense: 0 }
  );

  const totalSales = toMoney(totals.sale);
  const totalPurchases = toMoney(totals.purchase);
  const totalExpenses = toMoney(totals.expense);
  const profitLoss = toMoney(totalSales - (totalPurchases + totalExpenses));
  const currentBalance =
    bundle.user.user_type === "business"
      ? toMoney(openingBalance + totalSales - totalPurchases - totalExpenses)
      : toMoney(openingBalance - totalExpenses);

  return {
    user: sanitizeUser(bundle.user),
    opening_balance: openingBalance,
    starting_balance: openingBalance,
    current_balance: currentBalance,
    remaining_money: currentBalance,
    total_sales: totalSales,
    total_purchases: totalPurchases,
    total_expenses: totalExpenses,
    profit_loss: profitLoss
  };
}

function startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function last3DaySummary(transactions) {
  const now = startOfDay(new Date());
  const threeDaysAgo = new Date(now);
  threeDaysAgo.setDate(now.getDate() - 2);
  const previousWindowStart = new Date(threeDaysAgo);
  previousWindowStart.setDate(threeDaysAgo.getDate() - 3);

  const inWindow = (txn, start, end) => {
    const txnDate = startOfDay(`${txn.date}T00:00:00`);
    return txnDate >= start && txnDate <= end;
  };

  const sum = (items) =>
    items.reduce(
      (acc, txn) => {
        acc[txn.type] += Number(txn.amount);
        return acc;
      },
      { sale: 0, purchase: 0, expense: 0 }
    );

  const current = sum(transactions.filter((txn) => inWindow(txn, threeDaysAgo, now)));
  const previousEnd = new Date(threeDaysAgo);
  previousEnd.setDate(threeDaysAgo.getDate() - 1);
  const previous = sum(
    transactions.filter((txn) => inWindow(txn, previousWindowStart, previousEnd))
  );

  const currentProfit = current.sale - (current.purchase + current.expense);
  const previousProfit = previous.sale - (previous.purchase + previous.expense);
  const difference = toMoney(currentProfit - previousProfit);

  return {
    from: threeDaysAgo.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
    total_sales: toMoney(current.sale),
    total_purchases: toMoney(current.purchase),
    total_expenses: toMoney(current.expense),
    net_profit_loss: toMoney(currentProfit),
    trend: difference > 0 ? "increase" : difference < 0 ? "decrease" : "no change",
    trend_difference: difference
  };
}

function migrateLegacyJson() {
  if (!existsSync(LEGACY_JSON_FILE)) return;

  const existingUsers = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
  if (existingUsers > 0) return;

  const legacy = JSON.parse(readFileSync(LEGACY_JSON_FILE, "utf8") || "{}");
  const users = Array.isArray(legacy.users) ? legacy.users : [];
  const balances = Array.isArray(legacy.balances) ? legacy.balances : [];
  const transactions = Array.isArray(legacy.transactions) ? legacy.transactions : [];

  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, user_type, password_hash, password_salt, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBalance = db.prepare(`
    INSERT INTO balances (id, user_id, opening_balance)
    VALUES (?, ?, ?)
  `);
  const insertTransaction = db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount, description, date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
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
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

migrateLegacyJson();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, database: "sqlite" });
});

function createUser(req, res, { requirePassword }) {
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
  if (getUserByEmail(normalizedEmail)) {
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

  db.prepare(
    `INSERT INTO users (id, name, email, user_type, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    user.name,
    user.email,
    user.user_type,
    user.password_hash,
    user.password_salt,
    user.created_at
  );
  db.prepare("INSERT INTO balances (id, user_id, opening_balance) VALUES (?, ?, ?)").run(
    balance.id,
    balance.user_id,
    balance.opening_balance
  );

  res.status(201).json({ user: sanitizeUser(user), balance });
}

app.post("/api/auth/signup", (req, res) => createUser(req, res, { requirePassword: true }));

app.post("/api/create-user", (req, res) => createUser(req, res, { requirePassword: false }));

app.post("/api/auth/login", (req, res) => {
  const { email = "", password = "" } = req.body;
  const user = getUserByEmail(email);

  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  res.json({ user: sanitizeUser(user) });
});

app.post("/api/transaction/add", (req, res) => {
  const { user_id, type, amount, description = "", date = todayIso() } = req.body;
  const cleanDescription = description.trim();

  if (!user_id) return res.status(400).json({ error: "user_id is required." });
  if (!["sale", "purchase", "expense"].includes(type)) {
    return res.status(400).json({ error: "Type must be sale, purchase, or expense." });
  }
  if (!requireAmount(amount)) {
    return res.status(400).json({ error: "Amount must be greater than 0." });
  }
  if (!cleanDescription) {
    return res.status(400).json({ error: "Description is required." });
  }
  if (Number.isNaN(Date.parse(`${date}T00:00:00`))) {
    return res.status(400).json({ error: "Date must be valid." });
  }

  const bundle = getUserBundle(user_id);
  if (!bundle) return res.status(404).json({ error: "User not found." });
  if (bundle.user.user_type === "personal" && type !== "expense") {
    return res.status(400).json({ error: "Personal users can add expenses only." });
  }

  const transaction = {
    id: id("txn"),
    user_id,
    type,
    amount: toMoney(amount),
    description: cleanDescription,
    date,
    created_at: new Date().toISOString()
  };

  db.prepare(
    `INSERT INTO transactions (id, user_id, type, amount, description, date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    transaction.id,
    transaction.user_id,
    transaction.type,
    transaction.amount,
    transaction.description,
    transaction.date,
    transaction.created_at
  );

  const updatedBundle = getUserBundle(user_id);
  res.status(201).json({
    transaction,
    dashboard: calculateDashboard(updatedBundle),
    summary: last3DaySummary(updatedBundle.transactions)
  });
});

app.get("/api/transactions/list", (req, res) => {
  const userId = req.query.user_id;
  const page = Number(req.query.page || 0);
  const limit = Number(req.query.limit || 0);
  const whereSql = userId ? "WHERE user_id = ?" : "";
  const params = userId ? [userId] : [];

  if (page > 0 && limit > 0) {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const total = db
      .prepare(`SELECT COUNT(*) AS total FROM transactions ${whereSql}`)
      .get(...params).total;
    const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
    const safePage = Math.min(Math.max(page, 1), totalPages);
    const offset = (safePage - 1) * safeLimit;
    const items = db
      .prepare(
        `SELECT * FROM transactions ${whereSql}
         ORDER BY date DESC, created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, safeLimit, offset);

    return res.json({
      items,
      page: safePage,
      limit: safeLimit,
      total,
      total_pages: totalPages
    });
  }

  const transactions = db
    .prepare(`SELECT * FROM transactions ${whereSql} ORDER BY date DESC, created_at DESC`)
    .all(...params);
  res.json(transactions);
});

app.get("/api/dashboard/business", (req, res) => {
  const bundle = getUserBundle(req.query.user_id);
  if (!bundle) return res.status(404).json({ error: "User not found." });
  if (bundle.user.user_type !== "business") {
    return res.status(400).json({ error: "User is not a business user." });
  }

  res.json(calculateDashboard(bundle));
});

app.get("/api/dashboard/personal", (req, res) => {
  const bundle = getUserBundle(req.query.user_id);
  if (!bundle) return res.status(404).json({ error: "User not found." });
  if (bundle.user.user_type !== "personal") {
    return res.status(400).json({ error: "User is not a personal user." });
  }

  res.json(calculateDashboard(bundle));
});

app.get("/api/summary/last-3-days", (req, res) => {
  const bundle = getUserBundle(req.query.user_id);
  if (!bundle) return res.status(404).json({ error: "User not found." });

  res.json(last3DaySummary(bundle.transactions));
});

app.get("/api/users", (_req, res) => {
  const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
  res.json(users.map(sanitizeUser));
});

const server = app.listen(PORT, () => {
  console.log(`Daily Money Flow API running on http://localhost:${PORT}`);
  console.log(`SQLite database: ${SQLITE_FILE}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
