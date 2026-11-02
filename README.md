# SmartTransit Admin

Web dashboard for running the SmartTransit app: payments, customers, package
prices, insights and post moderation.

It is a static page (no build step) that talks to the app's Supabase
database. It contains no secrets: the key in `admin.js` is the public
(publishable) key, and every admin read and write is checked by the database
itself, so only accounts marked as admin can see or change anything.

GitHub Pages serves it straight from the `main` branch, so pushing to `main`
publishes it within a minute or two.
