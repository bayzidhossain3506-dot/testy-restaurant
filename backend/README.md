# Testy Restaurant API

Node.js + Express backend for the Testy Restaurant website.

## Run locally

```bash
cd backend
npm install
copy .env.example .env
npm run dev
```

The API runs on `http://localhost:5000` by default.

## Important

Set `TESTY_ADMIN_KEY` in `.env` to a long random secret. Never commit the real value to GitHub.

Current payment model: **Cash on Delivery / Pay at Restaurant**. No online payment gateway is required.

## Main endpoints

- `GET /api/health`
- `GET /api/menu`
- `POST /api/orders`
- `GET /api/orders/:orderNumber`
- `POST /api/reservations`
- `POST /api/admin/login`
- Admin-protected menu, order-status and reservation-status endpoints

The current backend keeps the existing API contract used by the website while replacing Flask with Express.
