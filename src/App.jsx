import { useEffect, useMemo, useState } from "react";

const API = "/api";
const today = new Date().toISOString().slice(0, 10);

function formatMoney(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

async function request(path, options) {
  const response = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function Stat({ label, value, tone = "neutral" }) {
  return (
    <div className={`stat ${tone}`}>
      <span>{label}</span>
      <strong>{formatMoney(value)}</strong>
    </div>
  );
}

function ThemeToggle({ theme, onToggle, icons }) {
  const Icon = theme === "dark" ? icons.Sun : icons.Moon;
  return (
    <button
      className="icon-button"
      onClick={onToggle}
      type="button"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      <Icon size={20} />
    </button>
  );
}

function AuthScreen({ onReady, theme, onThemeToggle, icons }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    user_type: "business",
    opening_balance: ""
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const path = mode === "signup" ? "/auth/signup" : "/auth/login";
      const body =
        mode === "signup"
          ? form
          : {
              email: form.email,
              password: form.password
            };
      const result = await request(path, {
        method: "POST",
        body: JSON.stringify(body)
      });
      localStorage.setItem("dmft_user_id", result.user.id);
      onReady(result.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="setup-shell">
      <section className="setup-panel">
        <div className="auth-header">
          <div className="brand">Daily Money Flow Tracker</div>
          <ThemeToggle theme={theme} onToggle={onThemeToggle} icons={icons} />
        </div>
        <h1>{mode === "signup" ? "Create your money tracker." : "Welcome back."}</h1>
        <div className="segmented auth-tabs" role="tablist" aria-label="Account mode">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => {
              setMode("login");
              setError("");
            }}
          >
            Login
          </button>
          <button
            type="button"
            className={mode === "signup" ? "active" : ""}
            onClick={() => {
              setMode("signup");
              setError("");
            }}
          >
            Sign Up
          </button>
        </div>
        <form className="setup-form" onSubmit={submit}>
          {mode === "signup" ? (
            <label>
              Name
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Shop or personal name"
                required
              />
            </label>
          ) : null}

          <label>
            Email
            <input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              placeholder={mode === "signup" ? "Minimum 6 characters" : "Your password"}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
            />
          </label>

          {mode === "signup" ? (
            <>
              <div className="segmented" role="tablist" aria-label="User type">
                <button
                  type="button"
                  className={form.user_type === "business" ? "active" : ""}
                  onClick={() => setForm({ ...form, user_type: "business" })}
                >
                  Business
                </button>
                <button
                  type="button"
                  className={form.user_type === "personal" ? "active" : ""}
                  onClick={() => setForm({ ...form, user_type: "personal" })}
                >
                  Personal
                </button>
              </div>

              <label>
                {form.user_type === "business" ? "Opening Balance" : "Starting Balance"}
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={form.opening_balance}
                  onChange={(event) => setForm({ ...form, opening_balance: event.target.value })}
                  placeholder="50000"
                  required
                />
              </label>
            </>
          ) : null}

          {error ? <p className="error">{error}</p> : null}
          <button className="primary" type="submit" disabled={saving}>
            {saving
              ? mode === "signup"
                ? "Creating..."
                : "Logging in..."
              : mode === "signup"
                ? "Create Account"
                : "Login"}
          </button>
        </form>
      </section>
    </main>
  );
}

function EntryForm({ user, activeType, setActiveType, onAdded, icons }) {
  const allowedTypes =
    user.user_type === "business"
      ? ["sale", "purchase", "expense", "income"]
      : ["expense", "income"];
  const [form, setForm] = useState({ amount: "", description: "", date: today });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!allowedTypes.includes(activeType)) setActiveType("expense");
  }, [activeType, allowedTypes, setActiveType]);

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (activeType === "income") {
      const confirmed = window.confirm(
        `Add ${formatMoney(form.amount)} to your balance as "${form.description}"? This will increase balance but will not count as profit.`
      );
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      const result = await request("/transaction/add", {
        method: "POST",
        body: JSON.stringify({
          user_id: user.id,
          type: activeType,
          amount: form.amount,
          description: form.description,
          date: form.date
        })
      });
      setForm({ amount: "", description: "", date: today });
      onAdded(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const labels = {
    sale: "Sale",
    purchase: "Purchase",
    expense: "Expense",
    income: "Add Money"
  };

  return (
    <section className="entry-panel" aria-label="Add entry">
      <div className="quick-actions">
        {allowedTypes.map((type) => {
          const Icon =
            type === "sale"
              ? icons.ArrowUpCircle
              : type === "purchase"
                ? icons.ArrowDownCircle
                : type === "income"
                  ? icons.CircleDollarSign
                  : icons.MinusCircle;
          return (
            <button
              key={type}
              className={activeType === type ? "active" : ""}
              type="button"
              onClick={() => setActiveType(type)}
              title={`Add ${labels[type]}`}
            >
              <Icon size={18} />
              {labels[type]}
            </button>
          );
        })}
      </div>

      <form className="entry-form" onSubmit={submit}>
        <label>
          Amount
          <input
            autoFocus
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={form.amount}
            onChange={(event) => setForm({ ...form, amount: event.target.value })}
            placeholder="0"
            required
          />
        </label>
        <label>
          Description
          <input
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            placeholder={
              activeType === "expense"
                ? "Rent, tea, fuel"
                : activeType === "income"
                  ? user.user_type === "business"
                    ? "Owner cash, capital"
                    : "Salary, bonus"
                  : `${labels[activeType]} details`
            }
            required
          />
        </label>
        <label>
          Date
          <input
            type="date"
            value={form.date}
            onChange={(event) => setForm({ ...form, date: event.target.value })}
            required
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="primary add-button" type="submit" disabled={saving}>
          <icons.Plus size={20} />
          {saving ? "Adding..." : `Add ${labels[activeType]}`}
        </button>
      </form>
    </section>
  );
}

function TransactionList({ transactions, pagination, onPageChange }) {
  if (!transactions.length) {
    return <p className="empty">No entries yet. Add the first one above.</p>;
  }

  return (
    <section className="transactions" aria-label="Recent transactions">
      <div className="section-heading">
        <h2>Recent Entries</h2>
        <span>{pagination.total} total</span>
      </div>
      <div className="txn-list">
        {transactions.map((txn) => (
          <article className={`txn ${txn.type}`} key={txn.id}>
            <div>
              <strong>{txn.type}</strong>
              <span>{txn.description || txn.date}</span>
            </div>
            <b>{formatMoney(txn.amount)}</b>
          </article>
        ))}
      </div>
      {pagination.total_pages > 1 ? (
        <div className="pagination" aria-label="Recent entries pagination">
          <button
            className="secondary"
            type="button"
            disabled={pagination.page <= 1}
            onClick={() => onPageChange(pagination.page - 1)}
          >
            Previous
          </button>
          <span>
            Page {pagination.page} of {pagination.total_pages}
          </span>
          <button
            className="secondary"
            type="button"
            disabled={pagination.page >= pagination.total_pages}
            onClick={() => onPageChange(pagination.page + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Dashboard({ user, icons, onReset, theme, onThemeToggle }) {
  const [dashboard, setDashboard] = useState(null);
  const [summary, setSummary] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [transactionPage, setTransactionPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, total_pages: 1, total: 0 });
  const [activeType, setActiveType] = useState(user.user_type === "business" ? "sale" : "expense");
  const [error, setError] = useState("");
  const transactionLimit = 5;

  const dashboardPath = user.user_type === "business" ? "/dashboard/business" : "/dashboard/personal";

  async function refresh(page = transactionPage) {
    const [dashboardData, summaryData, transactionData] = await Promise.all([
      request(`${dashboardPath}?user_id=${user.id}`),
      request(`/summary/last-3-days?user_id=${user.id}`),
      request(`/transactions/list?user_id=${user.id}&page=${page}&limit=${transactionLimit}`)
    ]);
    setDashboard(dashboardData);
    setSummary(summaryData);
    setTransactions(transactionData.items);
    setPagination({
      page: transactionData.page,
      total_pages: transactionData.total_pages,
      total: transactionData.total
    });
    setTransactionPage(transactionData.page);
  }

  useEffect(() => {
    refresh(transactionPage).catch((err) => setError(err.message));
  }, [user.id, transactionPage]);

  const profitTone = useMemo(() => {
    if (!dashboard) return "neutral";
    return dashboard.profit_loss >= 0 ? "positive" : "negative";
  }, [dashboard]);

  function handleAdded(result) {
    setDashboard(result.dashboard);
    setSummary(result.summary);
    setTransactionPage(1);
    refresh(1).catch((err) => setError(err.message));
  }

  if (error) {
    return (
      <main className="app-shell">
        <p className="error">{error}</p>
        <button className="secondary" onClick={onReset} type="button">
          Start Over
        </button>
      </main>
    );
  }

  if (!dashboard || !summary) {
    return <main className="app-shell loading">Loading dashboard...</main>;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span>{user.user_type === "business" ? "Business" : "Personal"}</span>
          <h1>{user.name}</h1>
        </div>
        <div className="topbar-actions">
          <ThemeToggle theme={theme} onToggle={onThemeToggle} icons={icons} />
          <button className="icon-button" onClick={onReset} type="button" title="Logout">
            <icons.LogOut size={20} />
          </button>
        </div>
      </header>

      <section className="hero-balance">
        <span>{user.user_type === "business" ? "Current Balance" : "Remaining Balance"}</span>
        <strong>{formatMoney(dashboard.current_balance)}</strong>
        {user.user_type === "business" ? (
          <em className={profitTone}>
            {dashboard.profit_loss >= 0 ? "Profit" : "Loss"} {formatMoney(Math.abs(dashboard.profit_loss))}
          </em>
        ) : (
          <em>
            Added {formatMoney(dashboard.total_income)} · Spent {formatMoney(dashboard.total_expenses)}
          </em>
        )}
      </section>

      <EntryForm
        user={user}
        activeType={activeType}
        setActiveType={setActiveType}
        onAdded={handleAdded}
        icons={icons}
      />

      <section className="grid-stats">
        <Stat
          label={user.user_type === "business" ? "Opening" : "Starting"}
          value={dashboard.opening_balance}
        />
        {user.user_type === "business" ? (
          <>
            <Stat label="Sales" value={dashboard.total_sales} tone="positive" />
            <Stat label="Purchases" value={dashboard.total_purchases} tone="warning" />
          </>
        ) : null}
        <Stat label="Added Money" value={dashboard.total_income} tone="positive" />
        <Stat label="Expenses" value={dashboard.total_expenses} tone="negative" />
      </section>

      {user.user_type === "business" ? (
        <section className="summary">
          <div>
            <span>Last 3 Days</span>
            <strong>{formatMoney(summary.net_profit_loss)}</strong>
          </div>
          <div className={`trend ${summary.trend.replace(" ", "-")}`}>
            {summary.trend} {formatMoney(Math.abs(summary.trend_difference))}
          </div>
          <dl>
            <div>
              <dt>Sales</dt>
              <dd>{formatMoney(summary.total_sales)}</dd>
            </div>
            <div>
              <dt>Purchases</dt>
              <dd>{formatMoney(summary.total_purchases)}</dd>
            </div>
            <div>
              <dt>Expenses</dt>
              <dd>{formatMoney(summary.total_expenses)}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      <TransactionList
        transactions={transactions}
        pagination={pagination}
        onPageChange={setTransactionPage}
      />
    </main>
  );
}

export default function App({ icons }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState(() => {
    const savedTheme = localStorage.getItem("dmft_theme");
    if (savedTheme === "light" || savedTheme === "dark") return savedTheme;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#101713" : "#173f35");
    localStorage.setItem("dmft_theme", theme);
  }, [theme]);

  useEffect(() => {
    async function loadUser() {
      const savedId = localStorage.getItem("dmft_user_id");
      if (!savedId) {
        setLoading(false);
        return;
      }
      try {
        const result = await request(`/users/me?user_id=${savedId}`);
        setUser(result.user);
      } finally {
        setLoading(false);
      }
    }
    loadUser();
  }, []);

  function reset() {
    localStorage.removeItem("dmft_user_id");
    setUser(null);
  }

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  if (loading) return <main className="app-shell loading">Loading...</main>;
  if (!user) {
    return (
      <AuthScreen
        onReady={setUser}
        theme={theme}
        onThemeToggle={toggleTheme}
        icons={icons}
      />
    );
  }
  return (
    <Dashboard
      user={user}
      icons={icons}
      onReset={reset}
      theme={theme}
      onThemeToggle={toggleTheme}
    />
  );
}
