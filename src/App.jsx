import { useEffect, useMemo, useRef, useState } from "react";

const API = "/api";

function localTodayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const TYPE_LABELS = {
  sale: "Sale",
  purchase: "Purchase",
  expense: "Expense",
  income: "Add Money",
  credit_sale: "Credit Sale",
  collection: "Payment In",
  credit_purchase: "Credit Purchase",
  supplier_payment: "Payment Out"
};

const EMPTY_FILTERS = { type: "", from: "", to: "" };

function hasActiveFilters(filters) {
  return Boolean(filters.type || filters.from || filters.to);
}

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

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new Error(text.slice(0, 160) || `Request failed (${response.status}).`);
      }
      throw new Error("Server returned an invalid response. Please try again.");
    }
  }

  if (!response.ok) {
    throw new Error(data.error || text.slice(0, 160) || `Request failed (${response.status}).`);
  }

  return data;
}

function formatEntryDate(dateString) {
  if (!dateString) return "";
  const [year, month, day] = dateString.split("-").map(Number);
  if (!year || !month || !day) return dateString;
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(year, month - 1, day));
}

function formatEntryTime(isoString) {
  if (!isoString) return "";
  const value = new Date(isoString);
  if (Number.isNaN(value.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(value);
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

function EntryForm({ user, activeType, setActiveType, onAdded, icons, parties, onCreateParty }) {
  const allowedTypes =
    user.user_type === "business"
      ? ["sale", "purchase", "expense", "income"]
      : ["expense", "income"];
  const [form, setForm] = useState({ amount: "", description: "", date: localTodayIso() });
  const [paymentMode, setPaymentMode] = useState("cash");
  const [partyName, setPartyName] = useState("");
  const [partyPhone, setPartyPhone] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const canCredit = activeType === "sale" || activeType === "purchase";
  const partyRole = activeType === "sale" ? "customer" : "supplier";
  const isCredit = canCredit && paymentMode === "credit";
  const roleParties = (parties || []).filter((party) => party.role === partyRole);

  useEffect(() => {
    if (!allowedTypes.includes(activeType)) setActiveType("expense");
  }, [activeType, allowedTypes, setActiveType]);

  useEffect(() => {
    setPaymentMode("cash");
    setPartyName("");
    setPartyPhone("");
    setError("");
  }, [activeType]);

  async function submit(event) {
    event.preventDefault();
    setError("");

    let effectiveType = activeType;
    let partyId = null;

    if (isCredit) {
      effectiveType = activeType === "sale" ? "credit_sale" : "credit_purchase";
      const trimmed = partyName.trim();
      if (!trimmed) {
        setError(`Enter the ${partyRole} name.`);
        return;
      }
      const existing = roleParties.find(
        (party) => party.name.toLowerCase() === trimmed.toLowerCase()
      );
      setSaving(true);
      try {
        if (existing) {
          partyId = existing.id;
        } else {
          const created = await onCreateParty({
            name: trimmed,
            role: partyRole,
            phone: partyPhone.trim()
          });
          partyId = created.id;
        }
      } catch (err) {
        setError(err.message);
        setSaving(false);
        return;
      }
    } else if (activeType === "income") {
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
          type: effectiveType,
          amount: form.amount,
          description: form.description,
          date: form.date,
          party_id: partyId
        })
      });
      setForm({ amount: "", description: "", date: localTodayIso() });
      setPartyName("");
      setPartyPhone("");
      setPaymentMode("cash");
      onAdded(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const labels = TYPE_LABELS;
  const submitLabel = isCredit
    ? activeType === "sale"
      ? "Add Credit Sale"
      : "Add Credit Purchase"
    : `Add ${labels[activeType]}`;

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

      {canCredit ? (
        <div className="segmented payment-mode" role="tablist" aria-label="Payment mode">
          <button
            type="button"
            className={paymentMode === "cash" ? "active" : ""}
            onClick={() => setPaymentMode("cash")}
          >
            Cash
          </button>
          <button
            type="button"
            className={paymentMode === "credit" ? "active" : ""}
            onClick={() => setPaymentMode("credit")}
          >
            Udhaar
          </button>
        </div>
      ) : null}

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

        {isCredit ? (
          <>
            <label>
              {partyRole === "customer" ? "Customer" : "Supplier"}
              <input
                list="entry-party-list"
                value={partyName}
                onChange={(event) => setPartyName(event.target.value)}
                placeholder={partyRole === "customer" ? "Customer name" : "Supplier name"}
                required
              />
              <datalist id="entry-party-list">
                {roleParties.map((party) => (
                  <option key={party.id} value={party.name} />
                ))}
              </datalist>
            </label>
            <label>
              Phone (optional)
              <input
                value={partyPhone}
                onChange={(event) => setPartyPhone(event.target.value)}
                placeholder="For new names only"
                inputMode="tel"
              />
            </label>
          </>
        ) : null}

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
                  : isCredit
                    ? "Goods given (kurti, set...)"
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
        {isCredit ? (
          <p className="entry-hint">
            {partyRole === "customer"
              ? "Goods given on udhaar. Cash & profit count only when payment is received."
              : "Stock taken on udhaar. Cost counts only when you pay the supplier."}
          </p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        <button className="primary add-button" type="submit" disabled={saving}>
          <icons.Plus size={20} />
          {saving ? "Adding..." : submitLabel}
        </button>
      </form>
    </section>
  );
}

function EntryFilters({ user, draft, onDraftChange, onApply, onClear, hasFilters, searching }) {
  const types =
    user.user_type === "business"
      ? ["sale", "purchase", "expense", "income"]
      : ["expense", "income"];

  return (
    <section className="entry-filters" aria-label="Filter entries">
      <div className="section-heading">
        <h2>Find Entries</h2>
        {hasFilters ? (
          <button className="text-button" type="button" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      <div className="filter-types" role="group" aria-label="Entry type">
        <button
          type="button"
          className={!draft.type ? "active" : ""}
          onClick={() => onDraftChange({ ...draft, type: "" })}
        >
          All
        </button>
        {types.map((type) => (
          <button
            key={type}
            type="button"
            className={draft.type === type ? "active" : ""}
            onClick={() => onDraftChange({ ...draft, type })}
          >
            {TYPE_LABELS[type]}
          </button>
        ))}
      </div>
      <div className="filter-dates">
        <label>
          From
          <input
            type="date"
            value={draft.from}
            onChange={(event) => onDraftChange({ ...draft, from: event.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={draft.to}
            onChange={(event) => onDraftChange({ ...draft, to: event.target.value })}
          />
        </label>
      </div>
      <button className="secondary filter-search" type="button" disabled={searching} onClick={onApply}>
        {searching ? "Searching..." : "Search"}
      </button>
    </section>
  );
}

function TransactionList({
  transactions,
  total,
  hasMore,
  loadingMore,
  loading,
  hasFilters,
  onLoadMore,
  onDelete,
  deletingId,
  icons
}) {
  if (loading) {
    return <p className="empty">Loading entries...</p>;
  }

  if (!transactions.length) {
    return (
      <p className="empty">
        {hasFilters ? "No entries match these filters." : "No entries yet. Add the first one above."}
      </p>
    );
  }

  return (
    <section className="transactions" aria-label="Recent transactions">
      <div className="section-heading">
        <h2>{hasFilters ? "Filtered Entries" : "Recent Entries"}</h2>
        <span>
          Showing {transactions.length} of {total}
        </span>
      </div>
      <div className="txn-list">
        {transactions.map((txn) => (
          <article className={`txn ${txn.type}`} key={txn.id}>
            <div>
              <strong>
                {TYPE_LABELS[txn.type] || txn.type}
                {txn.party_name ? <span className="txn-party"> · {txn.party_name}</span> : null}
              </strong>
              <span>{txn.description}</span>
              <time className="txn-meta" dateTime={txn.created_at || txn.date}>
                {formatEntryDate(txn.date)}
                {txn.created_at ? ` · ${formatEntryTime(txn.created_at)}` : ""}
              </time>
            </div>
            <div className="txn-actions">
              <b>{formatMoney(txn.amount)}</b>
              <button
                className="delete-button"
                type="button"
                title={`Delete ${txn.type}`}
                disabled={deletingId === txn.id}
                onClick={() => onDelete(txn)}
              >
                <icons.Trash2 size={18} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {hasMore ? (
        <div className="load-more">
          <button
            className="secondary"
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function KhataScreen({ user, icons, onBack, parties, reloadParties, onCreateParty, onChanged }) {
  const [role, setRole] = useState("customer");
  const [selectedId, setSelectedId] = useState("");
  const [ledger, setLedger] = useState(null);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", phone: "" });
  const [payForm, setPayForm] = useState({ amount: "", description: "", date: localTodayIso() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const roleParties = (parties || []).filter((party) => party.role === role);
  const totalOutstanding = roleParties.reduce((acc, party) => acc + Number(party.outstanding || 0), 0);
  const isCustomer = role === "customer";

  async function openParty(partyId) {
    setSelectedId(partyId);
    setError("");
    setLoadingLedger(true);
    setPayForm({ amount: "", description: "", date: localTodayIso() });
    try {
      const data = await request(`/parties/ledger?user_id=${user.id}&party_id=${partyId}`);
      setLedger(data);
    } catch (err) {
      setError(err.message);
      setLedger(null);
    } finally {
      setLoadingLedger(false);
    }
  }

  function closeParty() {
    setSelectedId("");
    setLedger(null);
    setError("");
  }

  function switchRole(nextRole) {
    setRole(nextRole);
    setShowAdd(false);
    setAddForm({ name: "", phone: "" });
    closeParty();
  }

  async function submitAddParty(event) {
    event.preventDefault();
    setError("");
    const name = addForm.name.trim();
    if (!name) {
      setError(`Enter the ${role} name.`);
      return;
    }
    setBusy(true);
    try {
      await onCreateParty({ name, role, phone: addForm.phone.trim() });
      setAddForm({ name: "", phone: "" });
      setShowAdd(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitPayment(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await request("/transaction/add", {
        method: "POST",
        body: JSON.stringify({
          user_id: user.id,
          type: isCustomer ? "collection" : "supplier_payment",
          amount: payForm.amount,
          description: payForm.description,
          date: payForm.date,
          party_id: selectedId
        })
      });
      await reloadParties();
      await openParty(selectedId);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-title">
          <button className="icon-button" type="button" onClick={onBack} title="Back">
            <icons.ArrowLeft size={20} />
          </button>
          <div>
            <span>Khata</span>
            <h1>Udhaar Book</h1>
          </div>
        </div>
      </header>

      <div className="segmented" role="tablist" aria-label="Khata type">
        <button
          type="button"
          className={isCustomer ? "active" : ""}
          onClick={() => switchRole("customer")}
        >
          To Collect
        </button>
        <button
          type="button"
          className={!isCustomer ? "active" : ""}
          onClick={() => switchRole("supplier")}
        >
          To Pay
        </button>
      </div>

      <section className="hero-balance khata-hero">
        <span>{isCustomer ? "Total To Collect" : "Total To Pay"}</span>
        <strong className={isCustomer ? "positive" : "negative"}>
          {formatMoney(totalOutstanding)}
        </strong>
        <em>
          {roleParties.length} {isCustomer ? "customer" : "supplier"}
          {roleParties.length === 1 ? "" : "s"}
        </em>
      </section>

      {error && !selectedId ? <p className="error inline-error">{error}</p> : null}

      {selectedId && ledger ? (
        <section className="khata-detail">
          <div className="section-heading">
            <h2>{ledger.party.name}</h2>
            <button className="text-button" type="button" onClick={closeParty}>
              Back to list
            </button>
          </div>
          {ledger.party.phone ? <p className="khata-phone">{ledger.party.phone}</p> : null}
          <div className={`khata-outstanding ${isCustomer ? "positive" : "negative"}`}>
            <span>{isCustomer ? "Owes you" : "You owe"}</span>
            <strong>{formatMoney(ledger.party.outstanding)}</strong>
          </div>

          <form className="entry-form khata-pay" onSubmit={submitPayment}>
            <label>
              {isCustomer ? "Receive payment" : "Pay supplier"}
              <input
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={payForm.amount}
                onChange={(event) => setPayForm({ ...payForm, amount: event.target.value })}
                placeholder="0"
                required
              />
            </label>
            <label>
              Date
              <input
                type="date"
                value={payForm.date}
                onChange={(event) => setPayForm({ ...payForm, date: event.target.value })}
                required
              />
            </label>
            <label>
              Note (optional)
              <input
                value={payForm.description}
                onChange={(event) => setPayForm({ ...payForm, description: event.target.value })}
                placeholder={isCustomer ? "Cash received" : "Cash paid"}
              />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button className="primary add-button" type="submit" disabled={busy}>
              <icons.HandCoins size={20} />
              {busy ? "Saving..." : isCustomer ? "Receive Payment" : "Pay Supplier"}
            </button>
          </form>

          <div className="section-heading">
            <h2>Ledger</h2>
          </div>
          {loadingLedger ? (
            <p className="empty">Loading...</p>
          ) : ledger.transactions.length ? (
            <div className="txn-list">
              {ledger.transactions.map((txn) => (
                <article className={`txn ${txn.type}`} key={txn.id}>
                  <div>
                    <strong>{TYPE_LABELS[txn.type] || txn.type}</strong>
                    <span>{txn.description}</span>
                    <time className="txn-meta" dateTime={txn.created_at || txn.date}>
                      {formatEntryDate(txn.date)}
                      {txn.created_at ? ` · ${formatEntryTime(txn.created_at)}` : ""}
                    </time>
                  </div>
                  <div className="txn-actions">
                    <b>{formatMoney(txn.amount)}</b>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="empty">No entries yet.</p>
          )}
        </section>
      ) : (
        <section className="khata-list">
          <div className="section-heading">
            <h2>{isCustomer ? "Customers" : "Suppliers"}</h2>
            <button className="text-button" type="button" onClick={() => setShowAdd((value) => !value)}>
              {showAdd ? "Cancel" : "+ Add"}
            </button>
          </div>

          {showAdd ? (
            <form className="entry-form khata-add" onSubmit={submitAddParty}>
              <label>
                Name
                <input
                  value={addForm.name}
                  onChange={(event) => setAddForm({ ...addForm, name: event.target.value })}
                  placeholder={isCustomer ? "Customer name" : "Supplier name"}
                  required
                />
              </label>
              <label>
                Phone (optional)
                <input
                  value={addForm.phone}
                  onChange={(event) => setAddForm({ ...addForm, phone: event.target.value })}
                  inputMode="tel"
                  placeholder="Phone number"
                />
              </label>
              {error ? <p className="error">{error}</p> : null}
              <button className="primary add-button" type="submit" disabled={busy}>
                <icons.UserPlus size={20} />
                {busy ? "Adding..." : `Add ${isCustomer ? "Customer" : "Supplier"}`}
              </button>
            </form>
          ) : null}

          {roleParties.length ? (
            <div className="party-list">
              {roleParties.map((party) => (
                <button
                  type="button"
                  className="party-row"
                  key={party.id}
                  onClick={() => openParty(party.id)}
                >
                  <div>
                    <strong>{party.name}</strong>
                    {party.phone ? <span>{party.phone}</span> : null}
                  </div>
                  <b className={Number(party.outstanding) > 0 ? (isCustomer ? "positive" : "negative") : "muted"}>
                    {formatMoney(party.outstanding)}
                  </b>
                </button>
              ))}
            </div>
          ) : (
            <p className="empty">
              No {isCustomer ? "customers" : "suppliers"} yet. Add one to start a khata.
            </p>
          )}
        </section>
      )}
    </main>
  );
}

function Dashboard({ user, icons, onReset, theme, onThemeToggle }) {
  const [dashboard, setDashboard] = useState(null);
  const [summary, setSummary] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [listPage, setListPage] = useState(1);
  const [listMeta, setListMeta] = useState({ total: 0, total_pages: 1 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_FILTERS);
  const skipFilterReload = useRef(true);
  const [activeType, setActiveType] = useState(user.user_type === "business" ? "sale" : "expense");
  const [deletingId, setDeletingId] = useState("");
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [parties, setParties] = useState([]);
  const [view, setView] = useState("home");
  const isBusiness = user.user_type === "business";
  const transactionLimit = 5;

  async function reloadParties() {
    if (!isBusiness) return;
    try {
      const data = await request(`/parties?user_id=${user.id}`);
      setParties(Array.isArray(data?.items) ? data.items : []);
    } catch {
      // Khata is non-critical for the main dashboard; ignore load errors here.
    }
  }

  async function createParty({ name, role, phone }) {
    const data = await request("/parties", {
      method: "POST",
      body: JSON.stringify({ user_id: user.id, name, role, phone })
    });
    await reloadParties();
    return data.party;
  }

  const hasMore = listPage < listMeta.total_pages;
  const filtersActive = hasActiveFilters(appliedFilters);

  function fetchTransactionPage(page, filters = appliedFilters) {
    const params = new URLSearchParams({
      user_id: user.id,
      page: String(page),
      limit: String(transactionLimit)
    });
    if (filters.type) params.set("type", filters.type);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    return request(`/transactions/list?${params}`);
  }

  function applyTransactionPage(data, page) {
    setTransactions(Array.isArray(data?.items) ? data.items : []);
    setListPage(page);
    setListMeta({
      total: Number(data?.total || 0),
      total_pages: Number(data?.total_pages || 1)
    });
  }

  async function loadInitialTransactions(filters = appliedFilters) {
    setListLoading(true);
    setListError("");
    try {
      const data = await fetchTransactionPage(1, filters);
      applyTransactionPage(data, 1);
    } catch (err) {
      setListError(err.message || "Could not load entries.");
    } finally {
      setListLoading(false);
    }
  }

  function applySearch() {
    setAppliedFilters({ ...draftFilters });
  }

  function clearFilters() {
    setDraftFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
  }

  async function reloadLoadedTransactions(pageCount = listPage) {
    const pages = Math.max(1, pageCount);
    const results = await Promise.all(
      Array.from({ length: pages }, (_, index) => fetchTransactionPage(index + 1))
    );
    const seen = new Set();
    const merged = [];
    for (const data of results) {
      for (const txn of data.items) {
        if (seen.has(txn.id)) continue;
        seen.add(txn.id);
        merged.push(txn);
      }
    }
    const last = results[results.length - 1];
    setTransactions(merged);
    setListMeta({ total: last.total, total_pages: last.total_pages });

    if (pages > last.total_pages) {
      setListPage(last.total_pages);
      if (last.total_pages > 0 && last.total_pages !== pages) {
        await reloadLoadedTransactions(last.total_pages);
      }
      return;
    }

    setListPage(pages);
  }

  async function loadOverview() {
    const overview = await request(`/account/overview?user_id=${user.id}`);
    setDashboard(overview.dashboard);
    setSummary(overview.summary);
  }

  async function refresh() {
    setError("");
    try {
      await loadOverview();
    } catch (err) {
      setError(err.message || "Could not load dashboard.");
      return;
    }

    try {
      await loadInitialTransactions();
    } catch (err) {
      setListError(err.message || "Could not load recent entries.");
    }
  }

  useEffect(() => {
    if (skipFilterReload.current) {
      skipFilterReload.current = false;
      return;
    }
    loadInitialTransactions(appliedFilters);
  }, [appliedFilters]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setDashboard(null);
      setSummary(null);
      setError("");
      try {
        const overview = await request(`/account/overview?user_id=${user.id}`);
        if (cancelled) return;
        setDashboard(overview.dashboard);
        setSummary(overview.summary);
        await loadInitialTransactions();
        await reloadParties();
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not load dashboard.");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  async function loadMore() {
    if (loadingMore || listPage >= listMeta.total_pages) return;

    setLoadingMore(true);
    setError("");
    try {
      const nextPage = listPage + 1;
      const data = await fetchTransactionPage(nextPage);
      setTransactions((current) => {
        const seen = new Set(current.map((txn) => txn.id));
        const merged = [...current];
        for (const txn of data.items) {
          if (seen.has(txn.id)) continue;
          seen.add(txn.id);
          merged.push(txn);
        }
        return merged;
      });
      setListPage(nextPage);
      setListMeta({ total: data.total, total_pages: data.total_pages });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  }

  const profitTone = useMemo(() => {
    if (!dashboard) return "neutral";
    return dashboard.profit_loss >= 0 ? "positive" : "negative";
  }, [dashboard]);

  function handleAdded(result) {
    setDashboard(result.dashboard);
    setSummary(result.summary);
    loadInitialTransactions().catch((err) => setError(err.message));
    reloadParties();
  }

  async function handleDelete(txn) {
    const confirmed = window.confirm(
      `Delete this ${txn.type} of ${formatMoney(txn.amount)}?\n\nThis cannot be undone.`
    );
    if (!confirmed) return;

    setDeletingId(txn.id);
    setError("");
    try {
      const result = await request("/transaction/delete", {
        method: "POST",
        body: JSON.stringify({
          user_id: user.id,
          transaction_id: txn.id
        })
      });
      setDashboard(result.dashboard);
      setSummary(result.summary);
      await reloadLoadedTransactions();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId("");
    }
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

  if (isBusiness && view === "khata") {
    return (
      <KhataScreen
        user={user}
        icons={icons}
        onBack={() => setView("home")}
        parties={parties}
        reloadParties={reloadParties}
        onCreateParty={createParty}
        onChanged={() => {
          loadOverview().catch((err) => setError(err.message));
          loadInitialTransactions().catch(() => {});
        }}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span>{user.user_type === "business" ? "Business" : "Personal"}</span>
          <h1>{user.name}</h1>
        </div>
        <div className="topbar-actions">
          {isBusiness ? (
            <button
              className="icon-button"
              onClick={() => setView("khata")}
              type="button"
              title="Khata / Udhaar"
            >
              <icons.BookUser size={20} />
            </button>
          ) : null}
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
        parties={parties}
        onCreateParty={createParty}
      />

      {isBusiness ? (
        <section className="khata-cards">
          <button
            type="button"
            className="khata-card to-collect"
            onClick={() => setView("khata")}
          >
            <span>
              <icons.Users size={16} /> To Collect
            </span>
            <strong>{formatMoney(dashboard.total_receivable || 0)}</strong>
          </button>
          <button
            type="button"
            className="khata-card to-pay"
            onClick={() => setView("khata")}
          >
            <span>
              <icons.HandCoins size={16} /> To Pay
            </span>
            <strong>{formatMoney(dashboard.total_payable || 0)}</strong>
          </button>
        </section>
      ) : null}

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

      <section className="summary">
        <div>
          <span>This Month</span>
          <strong>
            {user.user_type === "business"
              ? formatMoney(summary.net_profit_loss)
              : formatMoney(summary.net_cash_flow ?? summary.net_profit_loss)}
          </strong>
        </div>
        {user.user_type === "business" ? (
          <div className={`trend ${summary.trend.replace(" ", "-")}`}>
            {summary.trend} {formatMoney(Math.abs(summary.trend_difference))}
          </div>
        ) : null}
        <dl>
          {user.user_type === "business" ? (
            <>
              <div>
                <dt>Sales</dt>
                <dd>{formatMoney(summary.total_sales)}</dd>
              </div>
              <div>
                <dt>Purchases</dt>
                <dd>{formatMoney(summary.total_purchases)}</dd>
              </div>
            </>
          ) : (
            <div>
              <dt>Added</dt>
              <dd>{formatMoney(summary.total_income)}</dd>
            </div>
          )}
          <div>
            <dt>Expenses</dt>
            <dd>{formatMoney(summary.total_expenses)}</dd>
          </div>
        </dl>
      </section>

      <EntryFilters
        user={user}
        draft={draftFilters}
        onDraftChange={setDraftFilters}
        onApply={applySearch}
        onClear={clearFilters}
        hasFilters={filtersActive}
        searching={listLoading}
      />
      {listError ? <p className="error inline-error">{listError}</p> : null}

      <TransactionList
        transactions={transactions}
        total={listMeta.total}
        hasMore={hasMore}
        loadingMore={loadingMore}
        loading={listLoading}
        hasFilters={filtersActive}
        onLoadMore={loadMore}
        onDelete={handleDelete}
        deletingId={deletingId}
        icons={icons}
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
      } catch (err) {
        if (String(err.message || "").toLowerCase().includes("not found")) {
          localStorage.removeItem("dmft_user_id");
        }
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
