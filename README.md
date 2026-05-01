# Daily Money Flow Tracker

A minimal daily-use money tracker for shop owners and personal expense tracking.

## Run

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:4000`

## Phone Testing

While `npm run dev` is running, open the network URL shown by Vite on a phone connected to the same Wi-Fi, for example:

```text
http://192.168.1.210:5173/
```

The app is PWA-ready with a manifest, icons, and service worker.

The UI includes a light/dark mode toggle and remembers the choice on the device.

For install testing:

- Android Chrome: open the HTTPS or localhost URL, then use **Install app** or **Add to Home screen**.
- iPhone Safari: open the HTTPS URL, tap Share, then **Add to Home Screen**.

Note: mobile browsers usually require HTTPS for full PWA install/service-worker behavior. The local network HTTP URL is good for UI testing; use an HTTPS deployment or tunnel for true install testing.

## API

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/create-user`
- `GET /api/users/me?user_id=...`
- `POST /api/transaction/add`
- `POST /api/transaction/delete`
- `GET /api/transactions/list?user_id=...&page=1&limit=5`
- `GET /api/dashboard/business?user_id=...`
- `GET /api/dashboard/personal?user_id=...`
- `GET /api/summary/month?user_id=...`

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

There is no public users-list endpoint. Inspect production users from the database dashboard, not from the public API.

Transaction types:

- `sale`: increases business balance and counts toward profit.
- `purchase`: decreases business balance and counts against profit.
- `expense`: decreases balance and counts against profit for business users.
- `income`: adds money to balance for salary, bonus, owner cash, or capital. It does not count as profit.

## Database

Local development uses SQLite through Node's built-in SQLite module.

Local data is stored in:

```text
server/data/money-tracker.sqlite
```

Tables:

- `users`
- `balances`
- `transactions`

No separate database server is needed. If an old `server/data/db.json` exists, the server migrates it into SQLite when the SQLite database is empty.

For production, set `DATABASE_URL` to a Postgres database connection string. The API automatically uses Postgres when `DATABASE_URL` exists, which is the recommended setup for Vercel.

## Vercel Deployment

This project is Vercel-ready:

- Frontend builds to `dist`
- API is served by `api/index.js`
- Routes are configured in `vercel.json`
- PWA install works best from the deployed HTTPS URL

Recommended production database:

1. Create a Vercel project from this repo.
2. Add a Neon Postgres integration from Vercel Marketplace.
3. Make sure `DATABASE_URL` is available in Vercel environment variables.
4. Deploy.

Vercel is good for HTTPS/PWA install testing. SQLite is kept for local development only.
