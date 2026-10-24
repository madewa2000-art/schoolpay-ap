# SchoolPay

A school fees portal I built for my uncle's school in Ekiti State. Parents pay fees online and get a receipt straight away, and the school can see who has paid without matching bank alerts by hand. I also set up the school's Paystack account to go with it.

My brief was the fees side only, so that's what this covers. It isn't in use right now, because the school went on to need a full school management system.

## How it's laid out

It was built so more than one school could use it, which gives it three sides:

- **Parents:** pay fees by category, download receipts, raise a complaint if something looks wrong
- **School admin:** set up fee categories, see payments and receipts, upload bank documents, answer complaints
- **Platform admin:** add new schools

## Built with

Node.js and Express, PostgreSQL, Paystack (webhooks plus a verify step, so a payment is confirmed even if the webhook is late), Cloudinary for bank documents and Nodemailer for receipts. The front end is plain HTML, CSS and JavaScript.

## Running it locally

You need Node.js 18+ and PostgreSQL.

```bash
npm run build                          # installs the server
cp server/.env.example server/.env     # fill in the database, JWT_SECRET and Paystack details
npm start                              # http://localhost:4000
```

The schema in `server/db/schema.sql` is applied on start. To create the first platform admin, set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` before the first run.
