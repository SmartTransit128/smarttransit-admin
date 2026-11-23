# TeleTransit Admin

Web dashboard for running the TeleTransit app: the business-plan report
(revenue, refunds, commissions, retention, watch list), payments and refunds,
partner payouts, partners and referrals, customers, package and bundle
prices, offers, settings (commission rate, refund window, minimum withdrawal,
fair use), insights and post moderation.

It is a static page (no build step) that talks to the app's Supabase
database. It contains no secrets: the key in `admin.js` is the public
(publishable) key, and every admin read and write is checked by the database
itself, so only accounts marked as admin can see or change anything.

GitHub Pages serves it straight from the `main` branch, so pushing to `main`
publishes it within a minute or two.
