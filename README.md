# Daily Money Flow Tracker

A minimal daily-use money tracker for shop owners and personal expense tracking.

## Run

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:4000`

## API

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/create-user`
- `POST /api/transaction/add`
- `GET /api/transactions/list?user_id=...&page=1&limit=5`
- `GET /api/dashboard/business?user_id=...`
- `GET /api/dashboard/personal?user_id=...`
- `GET /api/summary/last-3-days?user_id=...`

Signup payload:

```json
{
  "name": "Sample Shop",
  "email": "shop@example.com",
  "password": "secret123",
  "user_type": "business",
  "opening_balance": 50000
}
```

Transaction descriptions are required for sale, purchase, and expense entries.

Recent entries use API pagination. When `page` and `limit` are provided, the response includes `items`, `page`, `limit`, `total`, and `total_pages`.

## Database

The MVP uses SQLite through Node's built-in SQLite module.

Data is stored locally in:

```text
server/data/money-tracker.sqlite
```

Tables:

- `users`
- `balances`
- `transactions`

No separate database server is needed. If an old `server/data/db.json` exists, the server migrates it into SQLite when the SQLite database is empty.
