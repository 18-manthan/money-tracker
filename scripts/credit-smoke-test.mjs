// Ad-hoc smoke test for the udhaari/credit flow against a running local server.
// Usage: PORT=4100 node server/index.js  (in one shell)
//        BASE=http://localhost:4100 node scripts/credit-smoke-test.mjs

const BASE = process.env.BASE || "http://localhost:4100";

async function call(path, options) {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

function assert(cond, msg, extra) {
  if (!cond) {
    console.error("FAIL:", msg, extra ? JSON.stringify(extra) : "");
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("ok  -", msg);
}

const round = (n) => Math.round(Number(n) * 100) / 100;

async function main() {
  const email = `credit_${Date.now()}@test.local`;

  const signup = await call("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      name: "Credit Test Shop",
      email,
      password: "secret123",
      user_type: "business",
      opening_balance: 10000
    })
  });
  assert(signup.ok, "signup business user", signup.data);
  const userId = signup.data.user.id;

  // Baseline overview
  let ov = await call(`/account/overview?user_id=${userId}`);
  assert(ov.ok, "overview loads", ov.data);
  assert(round(ov.data.dashboard.current_balance) === 10000, "opening cash = 10000", ov.data.dashboard);
  assert(round(ov.data.dashboard.total_receivable) === 0, "receivable 0", ov.data.dashboard);

  // Cash sale 2000
  await call("/transaction/add", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, type: "sale", amount: 2000, description: "cash sale" })
  });

  // Create customer
  const cust = await call("/parties", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, name: "Ramesh", role: "customer", phone: "999" })
  });
  assert(cust.ok, "create customer", cust.data);
  const customerId = cust.data.party.id;

  // Credit sale 5000 (no cash, no profit, +receivable)
  const credit = await call("/transaction/add", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      type: "credit_sale",
      amount: 5000,
      description: "udhaar kurti",
      party_id: customerId
    })
  });
  assert(credit.ok, "credit sale added", credit.data);
  assert(round(credit.data.dashboard.current_balance) === 12000, "cash unchanged after credit sale (12000)", credit.data.dashboard);
  assert(round(credit.data.dashboard.total_sales) === 2000, "sales still 2000 after credit sale", credit.data.dashboard);
  assert(round(credit.data.dashboard.total_receivable) === 5000, "receivable 5000", credit.data.dashboard);

  // Credit sale without party -> error
  const noParty = await call("/transaction/add", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, type: "credit_sale", amount: 100, description: "x" })
  });
  assert(!noParty.ok && noParty.status === 400, "credit sale without party rejected", noParty.data);

  // Overpay collection (6000 > 5000) -> error
  const over = await call("/transaction/add", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, type: "collection", amount: 6000, party_id: customerId })
  });
  assert(!over.ok && over.status === 400, "overpay collection rejected", over.data);

  // Collection 3000 (cash +3000, receivable -3000, sales +3000)
  const coll = await call("/transaction/add", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, type: "collection", amount: 3000, party_id: customerId })
  });
  assert(coll.ok, "collection added", coll.data);
  assert(round(coll.data.dashboard.current_balance) === 15000, "cash 15000 after collection", coll.data.dashboard);
  assert(round(coll.data.dashboard.total_sales) === 5000, "sales 5000 after collection", coll.data.dashboard);
  assert(round(coll.data.dashboard.total_receivable) === 2000, "receivable 2000 after collection", coll.data.dashboard);

  // Supplier side
  const sup = await call("/parties", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, name: "Supplier A", role: "supplier" })
  });
  assert(sup.ok, "create supplier", sup.data);
  const supplierId = sup.data.party.id;

  await call("/transaction/add", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      type: "credit_purchase",
      amount: 4000,
      description: "stock",
      party_id: supplierId
    })
  });
  const payOv = await call("/transaction/add", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, type: "supplier_payment", amount: 4000, party_id: supplierId })
  });
  assert(payOv.ok, "supplier payment added", payOv.data);
  assert(round(payOv.data.dashboard.current_balance) === 11000, "cash 11000 after supplier payment", payOv.data.dashboard);
  assert(round(payOv.data.dashboard.total_payable) === 0, "payable 0 after full payment", payOv.data.dashboard);
  assert(round(payOv.data.dashboard.total_purchases) === 4000, "purchases 4000 after supplier payment", payOv.data.dashboard);

  // Profit = sales(5000) - purchases(4000) - expenses(0) = 1000
  assert(round(payOv.data.dashboard.profit_loss) === 1000, "profit 1000", payOv.data.dashboard);

  // Parties list outstanding
  const parties = await call(`/parties?user_id=${userId}`);
  assert(parties.ok, "list parties", parties.data);
  const ramesh = parties.data.items.find((p) => p.id === customerId);
  assert(round(ramesh.outstanding) === 2000, "Ramesh outstanding 2000", ramesh);

  // Ledger
  const ledger = await call(`/parties/ledger?user_id=${userId}&party_id=${customerId}`);
  assert(ledger.ok, "ledger loads", ledger.data);
  assert(ledger.data.transactions.length === 2, "Ramesh has 2 ledger entries", ledger.data.transactions.length);

  // Transactions list includes party_name
  const list = await call(`/transactions/list?user_id=${userId}&page=1&limit=20`);
  const withParty = list.data.items.find((t) => t.type === "credit_sale");
  assert(withParty && withParty.party_name === "Ramesh", "list shows party_name", withParty);

  console.log("\nALL CREDIT SMOKE TESTS PASSED");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
