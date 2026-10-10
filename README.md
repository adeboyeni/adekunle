# Softsub backend (Node.js + PostgreSQL)

Your own VTU backend: users, wallets, ledger, ArewaGate purchases, Paystack funding.
The mobile app talks ONLY to this server. ArewaGate keys never leave it.

## Run it
1. `cp .env.example .env` and fill it in (use a long random JWT_SECRET)
2. `npm install`
3. Create a Postgres database, then `npm run migrate`
4. **`npm run probe`** - prints ArewaGate's real responses (plan-type and plan lists are not documented in the spec). If `src/services/plans.js` `normalize()` doesn't match, adjust the field names there.
5. `npm start`
6. In the Paystack dashboard set the webhook URL to `https://YOUR-DOMAIN/webhooks/paystack`

## Endpoints
| Method | Path | Notes |
|---|---|---|
| POST | /auth/register, /auth/login | returns JWT |
| POST | /auth/pin | set 4-digit transaction PIN |
| GET | /vtu/wallet | customer balance |
| POST | /wallet/fund `{amount}` | returns Paystack checkout URL |
| GET | /vtu/data/plan-types/:network | |
| GET | /vtu/data/plans?network=&plan_type= | prices include your margin |
| POST | /vtu/data/buy | needs `Idempotency-Key` header + `pin` in body |
| POST | /vtu/airtime/buy | same |
| GET | /vtu/transactions, /vtu/transactions/:id | status polling for the app |

## How money stays safe
- Customer is debited first (row-locked), then ArewaGate is called with `Idempotency-Key = our transaction id`.
- `completed` -> done. `processing` -> debit stands, the poller checks every 30s. `failed` -> automatic refund, exactly once.
- Timeouts/unclear 5xx never refund blindly: the poller replays the same idempotency key, which cannot double-charge.
- Prices are computed server-side from ArewaGate's plan list. The app can never set its own price.
- Wallets are only credited from the signature-verified Paystack webhook, and only if the amount matches.

## Verify before going live (not yet tested against live ArewaGate)
- `GET /transaction/request/{id}`: the spec says integer id, purchases return a UUID reference. `reconcile()` in `services/purchase.js` uses the reference; confirm with one small live purchase.
- Buy N100 airtime and a small data plan; test a failure (invalid number) and confirm the refund.

## Next
TV + electricity (schema-driven, with meter/smartcard verify), admin margin controls, push notifications, Paystack virtual accounts, Getsub as backup provider.
