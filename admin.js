// TeleTransit admin dashboard.
//
// A static page that talks to the same Supabase database as the app, using
// the public (publishable) key plus the admin's own sign-in. Nothing secret
// lives here: every admin read and write is checked by the database itself
// (profiles.is_admin, enforced by row-level security and the admin_* SQL
// functions), so a non-admin who signs in sees nothing.
"use strict";

const SUPABASE_URL = "https://fpavhievwedzyqbfooic.supabase.co";
const SUPABASE_KEY = "sb_publishable_-2_W9YBaEX1JmqgXlqqhkA_0HHzqzZF";
const SESSION_KEY = "st.admin.session";
const TIME_ZONE = "Africa/Dar_es_Salaam";

const PACKAGE_NAMES = {
  "pkg-day": "Day Pass",
  "pkg-weekly": "Weekly Pass",
  "pkg-monthly": "Monthly Basic",
  "pkg-3month": "Three-Month Growth",
  "pkg-6month": "Six-Month Partner",
  "pkg-trial": "Free trial",
  "pkg-plan-daily": "Daily",
  "pkg-plan-weekly": "Weekly",
  "pkg-plan-monthly": "Monthly",
  "pkg-plan-quarterly": "Quarterly",
  "pkg-plan-annual": "Annual",
  "pkg-bundle-basic": "Basic bundle",
  "pkg-bundle-standard": "Standard bundle",
  "pkg-bundle-plus": "Plus bundle",
  "pkg-bundle-premium": "Premium bundle",
  "pkg-topup-10": "10 more customer numbers",
};
// Names admins set in the catalog (name_en) win over the built-in ones.
const catalogNames = {};
// The smallest payment Pesapal accepts.
const PESAPAL_MINIMUM = 1000;
const packageName = (id) => catalogNames[id] || PACKAGE_NAMES[id] || id || "—";

async function loadCatalogNames() {
  try {
    const rows = await rest("package_catalog?select=*&order=sort_order");
    for (const r of rows || []) if (r.name_en) catalogNames[r.id] = r.name_en;
    return rows || [];
  } catch {
    return null;
  }
}

const VIEWS = {
  overview: { title: "Overview", render: renderOverview },
  business: { title: "Business", render: renderBusiness },
  partners: { title: "Partners", render: renderPartners },
  payouts: { title: "Payouts", render: renderPayouts },
  payments: { title: "Payments", render: renderPayments },
  customers: { title: "Customers", render: renderCustomers },
  packages: { title: "Packages & prices", render: renderPackages },
  offers: { title: "Offers", render: renderOffers },
  insights: { title: "Insights", render: renderInsights },
  posts: { title: "Posts", render: renderPosts },
  settings: { title: "Settings", render: renderSettings },
};

// ── Small helpers ─────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

/// Builds DOM nodes. Text is always set as text, never parsed as HTML, so
/// names and posts typed by users can't inject anything into the page.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
const tzs = (v) => `TZS ${Math.round(num(v)).toLocaleString("en-US")}`;
const count = (v) => num(v).toLocaleString("en-US");

function fmtDate(value, withTime = true) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    timeZone: TIME_ZONE, day: "numeric", month: "short", year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

function toast(message, bad = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = bad ? "toast bad" : "toast";
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

function loading() {
  return h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading…");
}

function loadError(err, retry) {
  return h("div", { class: "load-error" },
    h("p", {}, errorText(err)),
    retry && h("button", { class: "btn", type: "button", onclick: retry }, "Try again"));
}

/// A stat tile that opens a page.
function linkStat(label, value, href, tone) {
  return h("a", { class: `stat link ${tone || ""}`, href },
    h("div", { class: "value" }, value),
    h("div", { class: "label" }, label, " →"));
}

function stat(label, value, tone) {
  return h("div", { class: `stat ${tone || ""}` },
    h("div", { class: "value" }, value),
    h("div", { class: "label" }, label));
}

function statusBadge(status, isMock) {
  const map = {
    completed: ["Paid", "ok"], pending: ["Waiting", "warn"],
    failed: ["Failed", "bad"], cancelled: ["Cancelled", "grey"],
    refunded: ["Refunded", "blue"],
  };
  const [label, tone] = map[status] || [status || "—", "grey"];
  return h("span", {},
    h("span", { class: `badge ${tone}` }, label),
    isMock ? [" ", h("span", { class: "badge grey" }, "Test")] : null);
}

function roleLabel(role) {
  return { sender: "Sender", provider: "Provider", both: "Sender & provider", admin: "Admin" }[role] || role || "—";
}

// ── Network ───────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(kind, status, detail) {
    super(detail || kind);
    this.kind = kind; // offline | timeout | auth | forbidden | server
    this.status = status;
  }
}

function errorText(err) {
  switch (err && err.kind) {
    case "offline": return "You appear to be offline. Check your internet connection.";
    case "timeout": return "The server took too long to answer. Try again.";
    case "auth": return "Your session has ended. Please sign in again.";
    case "forbidden": return "This account is not an admin.";
    default: return err && err.message && err.message !== "server"
      ? `Something went wrong: ${err.message}`
      : "Something went wrong. Try again in a moment.";
  }
}

async function http(url, options = {}) {
  if (navigator.onLine === false) throw new ApiError("offline");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    throw new ApiError(err.name === "AbortError" ? "timeout" : "offline");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const detail = body && (body.message || body.error_description || body.msg || body.error);
    const msg = typeof detail === "string" ? detail : "";
    let kind = "server";
    if (res.status === 401 || /JWT/i.test(msg)) kind = "auth";
    else if (res.status === 403 || /admins only|permission denied/i.test(msg)) kind = "forbidden";
    throw new ApiError(kind, res.status, msg);
  }
  return body;
}

// ── Session ───────────────────────────────────────────────────────────────

const store = {
  get() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } },
  set(v) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(v)); } catch { /* ignore */ } },
  clear() { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } },
};

function saveSession(data, previous) {
  const session = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    userId: data.user?.id ?? previous?.userId,
    email: data.user?.email ?? previous?.email ?? "",
  };
  store.set(session);
  return session;
}

async function signIn(email, password) {
  const data = await http(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  return saveSession(data);
}

let refreshing = null;
async function freshSession() {
  const s = store.get();
  if (!s || !s.accessToken || !s.refreshToken) return null;
  if (s.expiresAt - Date.now() > 60000) return s;
  // One refresh at a time, even if several requests start together.
  refreshing ??= http(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: s.refreshToken }),
  }).then((data) => saveSession(data, s))
    .catch((err) => {
      if (err.kind === "auth" || err.status === 400) { store.clear(); return null; }
      throw err;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function authHeaders() {
  const s = await freshSession();
  if (!s) throw new ApiError("auth", 401);
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${s.accessToken}` };
}

async function withAuth(fn) {
  try {
    return await fn(await authHeaders());
  } catch (err) {
    if (err.kind === "auth") showSignIn("Your session has ended. Please sign in again.");
    throw err;
  }
}

/// PostgREST table request, e.g. rest("payment_orders?select=*").
function rest(path, { method = "GET", body, prefer } = {}) {
  return withAuth((headers) => http(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }));
}

/// Calls a SQL function (every admin_* function checks is_admin itself).
function rpc(name, params = {}) {
  return withAuth((headers) => http(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  }));
}

function edgeGet(name) {
  return withAuth((headers) => http(`${SUPABASE_URL}/functions/v1/${name}`, { headers }));
}

function edgeFunction(name, body) {
  return withAuth((headers) => http(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

const enc = encodeURIComponent;
const PAYMENT_SELECT = "*,customer:profiles(id,full_name,email,phone)";

// ── App shell ─────────────────────────────────────────────────────────────

let me = null;

function showSignIn(message) {
  store.clear();
  me = null;
  stopAlerts();
  closeModal();
  $("app-view").hidden = true;
  $("signin-view").hidden = false;
  const err = $("signin-error");
  err.textContent = message || "";
  err.hidden = !message;
}

async function enterApp() {
  const s = await freshSession();
  if (!s) { showSignIn(); return; }
  try {
    const rows = await rest(`profiles?id=eq.${enc(s.userId)}&select=full_name,email,is_admin`);
    me = rows && rows[0];
  } catch (err) {
    if (err.kind !== "auth") showSignIn(errorText(err));
    return;
  }
  if (!me || !me.is_admin) {
    showSignIn("This account is not an admin. Use the admin account to sign in.");
    return;
  }
  $("who-name").textContent = me.full_name || "Admin";
  $("who-email").textContent = me.email || s.email;
  $("signin-view").hidden = true;
  $("app-view").hidden = false;
  await loadCatalogNames();
  route();
  startAlerts();
}

// ── Alerts: partners waiting to be paid ───────────────────────────────────
// Checked every minute while the dashboard is open: a bar at the top, a
// count on "Payouts" and in the tab title, and (if allowed) a desktop
// notification for each new request.

const BASE_TITLE = document.title;
let alertTimer = null;
let knownRequests = null;

function startAlerts() {
  clearInterval(alertTimer);
  knownRequests = null;
  checkPayouts();
  alertTimer = setInterval(checkPayouts, 60000);
}

function stopAlerts() {
  clearInterval(alertTimer);
  alertTimer = null;
  knownRequests = null;
  document.title = BASE_TITLE;
  document.querySelector("#nav .nav-badge")?.remove();
  const bar = $("alert-bar");
  if (bar) bar.hidden = true;
}

async function checkPayouts() {
  if (!me) return;
  let list;
  try {
    list = (await rpc("admin_withdrawals", { p_status: "requested" })) || [];
  } catch {
    return; // Try again next minute.
  }
  const n = list.length;
  const total = list.reduce((t, w) => t + num(w.amount), 0);

  const link = document.querySelector('#nav a[data-view="payouts"]');
  let badge = link?.querySelector(".nav-badge");
  if (n && link) {
    if (!badge) { badge = h("span", { class: "nav-badge" }); link.append(badge); }
    badge.textContent = String(n);
  } else {
    badge?.remove();
  }
  document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;

  const bar = $("alert-bar");
  if (bar) {
    bar.hidden = !n;
    if (n) {
      const canAsk = "Notification" in window && Notification.permission === "default";
      bar.replaceChildren(
        h("span", {}, h("b", {}, n === 1 ? "1 partner is waiting to be paid" : `${count(n)} partners are waiting to be paid`),
          ` · ${tzs(total)} in total`),
        h("span", { class: "alert-actions" },
          canAsk ? h("button", { class: "btn ghost small", type: "button", onclick: async () => {
            await Notification.requestPermission();
            checkPayouts();
          } }, "Turn on desktop alerts") : null,
          h("a", { class: "btn primary small", href: "#payouts" }, "Open payouts")));
    }
  }

  // New since the last check (not on the first check after signing in).
  if (knownRequests) {
    const fresh = list.filter((w) => !knownRequests.has(w.id));
    for (const w of fresh) {
      const text = `${w.full_name || "A partner"} asked to withdraw ${tzs(w.amount)}`;
      toast(text);
      if ("Notification" in window && Notification.permission === "granted") {
        try {
          new Notification("Withdrawal request", { body: text, tag: w.id, icon: "favicon.png" });
        } catch {
          // Some browsers only allow notifications from a service worker.
        }
      }
    }
  }
  knownRequests = new Set(list.map((w) => w.id));
}

/// Hash routes: #payments, #customers, #customers/<id>, …
function route() {
  if (!me) return;
  const [name, arg] = (location.hash.replace(/^#/, "") || "overview").split("/");
  const view = VIEWS[name] ? name : "overview";
  document.querySelectorAll("#nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === view);
  });
  $("view-title").textContent = VIEWS[view].title;
  const root = $("view");
  root.replaceChildren();
  closeModal();
  VIEWS[view].render(root, arg ? decodeURIComponent(arg) : null);
}

// ── Modal ─────────────────────────────────────────────────────────────────

function openModal(...content) {
  // Optional parts may be null/false: leave them out (never print "null").
  $("modal-body").replaceChildren(...content.flat(Infinity).filter((c) => c != null && c !== false));
  $("modal").hidden = false;
}
function closeModal() { $("modal").hidden = true; }

function confirmDialog({ title, body, confirmLabel, danger }) {
  return new Promise((resolve) => {
    const done = (ok) => { closeModal(); resolve(ok); };
    openModal(
      h("h2", { style: { marginTop: "0" } }, title),
      h("p", { class: "muted" }, body),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", type: "button", onclick: () => done(false) }, "Cancel"),
        h("button", { class: `btn ${danger ? "danger solid" : "primary"}`, type: "button", onclick: () => done(true) }, confirmLabel)),
    );
  });
}

// ── Overview ──────────────────────────────────────────────────────────────

async function renderOverview(root) {
  root.append(loading());
  const [summary, latest, insights, business, sources] = await Promise.allSettled([
    rpc("admin_payment_summary"),
    rest(`payment_orders?select=${PAYMENT_SELECT}&order=created_at.desc&limit=8`),
    rpc("admin_insights"),
    rpc("admin_business_report", { p_days: 30 }),
    rpc("admin_signup_sources", { p_days: 30 }),
  ]);
  root.replaceChildren();
  if (summary.status === "rejected") {
    root.append(loadError(summary.reason, () => route()));
    return;
  }
  const s = summary.value || {};
  root.append(
    h("div", { class: "stats" },
      stat("Revenue today", tzs(s.revenue_today), "money"),
      stat("Revenue this month", tzs(s.revenue_month), "money"),
      stat("Paid today", count(s.paid_today), "ok"),
      stat("Waiting now", count(s.waiting), "warn"),
      stat("Failed today", count(s.failed_today), "bad"),
      stat("Active packages", count(s.active_packages)),
      stat("Customers", count(s.customers))),
  );

  if (business.status === "fulfilled") {
    const b = business.value || {};
    const c = b.commissions || {}, u = b.users || {};
    root.append(
      h("h2", {}, "Partners & payouts"),
      h("div", { class: "stats" },
        linkStat("Payouts waiting", count(c.waiting_count), "#payouts", num(c.waiting_count) ? "warn" : ""),
        linkStat("Owed to partners", tzs(c.owed), "#partners", "money"),
        linkStat("Active partners", count(u.partners), "#partners"),
        stat("Referred users", count(u.referred)),
        stat("Credits not yet used", count(u.credits_outstanding))),
    );
  }

  if (sources.status === "fulfilled" && (sources.value || []).length) {
    const labels = {
      invited: "Invited by a partner", advert: "Advertisement", search: "Internet search",
      social: "Social media", other: "Other", unanswered: "Not asked (older app)",
    };
    const list = sources.value;
    const all = list.reduce((t, r) => t + num(r.people), 0);
    root.append(
      h("h2", {}, "How new people found TeleTransit (30 days)"),
      h("div", { class: "card" }, list.map((r) => h("div", { class: "source-row" },
        h("span", { class: "source-name" }, labels[r.source] || r.source),
        h("span", { class: "source-bar" }, h("span", { style: { width: `${all ? Math.round(num(r.people) / all * 100) : 0}%` } })),
        h("b", { class: "source-count" }, `${count(r.people)} · ${all ? Math.round(num(r.people) / all * 100) : 0}%`)))),
    );
  }

  if (insights.status === "fulfilled") {
    const d = insights.value || {};
    root.append(
      h("h2", {}, "Marketplace now"),
      h("div", { class: "stats" },
        stat("Live vehicles", count(d.listings?.live)),
        stat("Open requests", count(d.needs?.open)),
        stat("Deals closed", count(d.needs?.closed)),
        stat("New users (7 days)", count(d.users?.d7)),
        stat("Contacts opened (7 days)", count(d.contacts?.d7))),
    );
  }

  root.append(h("h2", {}, "Latest payments"));
  if (latest.status === "rejected") root.append(loadError(latest.reason));
  else root.append(paymentsTable(latest.value || [], true));
}

// ── Payments ──────────────────────────────────────────────────────────────

const paymentsState = { status: null, search: "" };

function renderPayments(root) {
  const list = h("div", {});
  const search = h("input", {
    type: "search", value: paymentsState.search,
    placeholder: "Search receipt no., reference, name, email or phone",
    oninput: () => { paymentsState.search = search.value; draw(); },
  });
  const filters = [[null, "All"], ["completed", "Paid"], ["pending", "Waiting"], ["failed", "Failed"], ["cancelled", "Cancelled"], ["refunded", "Refunded"]];
  const chips = h("div", { class: "chips" }, filters.map(([value, label]) => h("button", {
    type: "button", class: `chip ${paymentsState.status === value ? "on" : ""}`,
    onclick: () => { paymentsState.status = value; route(); },
  }, label)));
  root.append(h("div", { class: "toolbar" }, search, chips), list);

  let rows = null;
  function draw() {
    if (!rows) return;
    const q = paymentsState.search.trim().toLowerCase();
    const shown = !q ? rows : rows.filter((r) => [
      r.receipt_number, r.merchant_reference, r.confirmation_code, r.order_tracking_id,
      r.customer?.full_name, r.customer?.email, r.customer?.phone,
    ].some((v) => v && String(v).toLowerCase().includes(q)));
    list.replaceChildren(
      h("p", { class: "muted small" }, `${shown.length} payment${shown.length === 1 ? "" : "s"}${rows.length >= 500 ? " (latest 500)" : ""}`),
      paymentsTable(shown, true));
  }

  list.append(loading());
  const filter = paymentsState.status ? `&status=eq.${paymentsState.status}` : "";
  rest(`payment_orders?select=${PAYMENT_SELECT}${filter}&order=created_at.desc&limit=500`)
    .then((data) => { rows = data || []; draw(); })
    .catch((err) => list.replaceChildren(loadError(err, () => route())));
}

function paymentsTable(rows, showCustomer) {
  if (!rows.length) return h("div", { class: "table-wrap" }, h("div", { class: "empty" }, "No payments found."));
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {},
      h("th", {}, "Date"),
      showCustomer && h("th", {}, "Customer"),
      h("th", {}, "Package"),
      h("th", { class: "num" }, "Amount"),
      h("th", {}, "Status"),
      h("th", {}, "Receipt / reference"))),
    h("tbody", {}, rows.map((p) => h("tr", { class: "click", onclick: () => openPayment(p) },
      h("td", {}, fmtDate(p.created_at)),
      showCustomer && h("td", {},
        p.customer?.full_name || "—",
        h("div", { class: "sub" }, p.customer?.phone || p.customer?.email || "")),
      h("td", {}, packageName(p.package_id)),
      h("td", { class: "num" }, tzs(p.amount)),
      h("td", {}, statusBadge(p.status, p.is_mock)),
      h("td", {}, p.receipt_number || h("span", { class: "sub" }, p.merchant_reference || "—"))))),
  ));
}

function methodLabel(p) {
  if (p.method === "appleIap") return "Apple In-App Purchase";
  if (p.method === "azampay") return p.payment_method_code ? `AzamPay · ${p.payment_method_code}` : "AzamPay";
  if (p.method === "mock") return "Test (no money)";
  return p.payment_method_code ? `Pesapal · ${p.payment_method_code}` : "Pesapal";
}

function openPayment(p) {
  const recheck = h("button", { class: "btn primary", type: "button" }, "Re-check with Pesapal");
  recheck.addEventListener("click", async () => {
    recheck.disabled = true;
    recheck.replaceChildren(h("span", { class: "spinner" }), "Checking…");
    try {
      await edgeFunction("admin-payment-recheck", { orderTrackingId: p.order_tracking_id });
      const rows = await rest(`payment_orders?id=eq.${enc(p.id)}&select=${PAYMENT_SELECT}`);
      toast("Checked with Pesapal.");
      route(); // reload the list behind the popup
      if (rows && rows[0]) openPayment(rows[0]);
    } catch (err) {
      toast(err.kind === "offline" || err.kind === "timeout"
        ? errorText(err)
        : `Couldn't reach Pesapal. ${err.message && err.message !== "server" ? err.message : "Try again."}`, true);
      recheck.disabled = false;
      recheck.replaceChildren("Re-check with Pesapal");
    }
  });

  const c = p.customer || {};
  openModal(
    h("div", { class: "detail-head" },
      h("div", {},
        h("h2", {}, tzs(p.amount)),
        h("div", { class: "muted" }, packageName(p.package_id))),
      statusBadge(p.status, p.is_mock)),
    h("dl", { class: "kv" },
      h("dt", {}, "Receipt no."), h("dd", {}, p.receipt_number || "—"),
      h("dt", {}, "Reference"), h("dd", {}, p.merchant_reference || "—"),
      h("dt", {}, "Method"), h("dd", {}, methodLabel(p)),
      h("dt", {}, "Confirmation code"), h("dd", {}, p.confirmation_code || "—"),
      h("dt", {}, "Paid from"), h("dd", {}, p.payer_account || "—"),
      h("dt", {}, "Started"), h("dd", {}, fmtDate(p.created_at)),
      h("dt", {}, "Paid at"), h("dd", {}, fmtDate(p.completed_at)),
      h("dt", {}, "Last checked"), h("dd", {}, fmtDate(p.last_checked_at)),
      h("dt", {}, "Pesapal tracking ID"), h("dd", {}, p.order_tracking_id || "—"),
      h("dt", {}, "Customer"), h("dd", {},
        c.id ? h("a", { href: `#customers/${enc(c.id)}` }, c.full_name || "Open customer") : "—",
        c.email ? h("div", { class: "sub muted" }, c.email) : null,
        c.phone ? h("div", { class: "sub muted" }, c.phone) : null)),
    h("div", { class: "modal-actions" },
      p.status === "completed" && !p.is_mock
        ? h("button", { class: "btn danger", type: "button", onclick: () => openRefund(p) }, "Refund…")
        : null,
      p.order_tracking_id && p.method === "pesapal" && !["completed", "refunded"].includes(p.status) ? recheck : null,
      h("button", { class: "btn", type: "button", onclick: closeModal }, "Close")),
  );
}

/// Records a refund made in Pesapal's or AzamPay's portal and takes back
/// what it bought (package ended, unused credits removed, commission reversed).
function openRefund(p) {
  const reason = h("input", { type: "text", maxlength: "300", placeholder: "e.g. Paid twice by mistake" });
  const ref = h("input", { type: "text", maxlength: "100", placeholder: "Refund reference from Pesapal / AzamPay (optional)" });
  const error = h("p", { class: "error", hidden: true });
  const go = h("button", { class: "btn danger solid", type: "button" }, `Record refund of ${tzs(p.amount)}`);
  go.addEventListener("click", async () => {
    error.hidden = true;
    if (reason.value.trim().length < 3) { error.textContent = "Give a reason (at least 3 letters)."; error.hidden = false; return; }
    go.disabled = true;
    go.replaceChildren(h("span", { class: "spinner" }), "Recording…");
    try {
      const r = await rpc("admin_refund_payment", { p_order: p.id, p_reason: reason.value.trim(), p_provider_reference: ref.value.trim() || null });
      toast(num(r?.credits_removed) ? `Refund recorded. ${count(r.credits_removed)} unused credits removed.` : "Refund recorded.");
      route();
    } catch (err) {
      error.textContent = `Couldn't record the refund. ${errorText(err)}`;
      error.hidden = false;
      go.disabled = false;
      go.replaceChildren(`Record refund of ${tzs(p.amount)}`);
    }
  });
  openModal(
    h("h2", { style: { marginTop: "0" } }, "Refund this payment?"),
    h("div", { class: "note" },
      "First send the money back in the Pesapal or AzamPay portal — this page doesn't move money. " +
      "Recording it here ends the package now (vehicles on it stop showing), removes credits that weren't used, " +
      "and cancels the partner's commission. It can't be undone."),
    h("dl", { class: "kv" },
      h("dt", {}, "Customer"), h("dd", {}, p.customer?.full_name || "—"),
      h("dt", {}, "Bought"), h("dd", {}, packageName(p.package_id)),
      h("dt", {}, "Receipt"), h("dd", {}, p.receipt_number || p.merchant_reference || "—")),
    h("div", { class: "form", style: { marginTop: "16px" } },
      h("label", {}, "Reason", reason),
      h("label", {}, "Refund reference", ref),
      error),
    h("div", { class: "modal-actions" },
      h("button", { class: "btn", type: "button", onclick: () => openPayment(p) }, "Back"),
      go));
}

// ── Customers ─────────────────────────────────────────────────────────────

const customersState = { search: "" };

function renderCustomers(root, id) {
  if (id) { renderCustomer(root, id); return; }
  const list = h("div", {});
  const search = h("input", {
    type: "search", value: customersState.search,
    placeholder: "Search name, email or phone, then press Enter",
  });
  const form = h("form", { class: "toolbar", onsubmit: (e) => {
    e.preventDefault();
    customersState.search = search.value;
    load();
  } }, search, h("button", { class: "btn", type: "submit" }, "Search"));
  root.append(form, list);

  function load() {
    list.replaceChildren(loading());
    const q = customersState.search.trim().replace(/[,()%*\\:."']/g, "");
    const filter = q ? `&or=(${["full_name", "email", "phone"].map((f) => `${f}.ilike.*${enc(q)}*`).join(",")})` : "";
    rest(`profiles?select=id,full_name,email,phone,role,is_admin,created_at${filter}&order=created_at.desc&limit=200`)
      .then((rows) => {
        if (!rows.length) { list.replaceChildren(h("div", { class: "table-wrap" }, h("div", { class: "empty" }, "No customers found."))); return; }
        list.replaceChildren(
          h("p", { class: "muted small" }, `${rows.length} customer${rows.length === 1 ? "" : "s"}${rows.length >= 200 ? " (latest 200 — search to narrow down)" : ""}`),
          h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Contact"), h("th", {}, "Role"), h("th", {}, "Joined"))),
            h("tbody", {}, rows.map((c) => h("tr", { class: "click", onclick: () => { location.hash = `customers/${enc(c.id)}`; } },
              h("td", {}, c.full_name || "—", c.is_admin ? [" ", h("span", { class: "badge orange" }, "Admin")] : null),
              h("td", {}, c.email || "—", h("div", { class: "sub" }, c.phone || "")),
              h("td", {}, roleLabel(c.role)),
              h("td", {}, fmtDate(c.created_at, false))))))));
      })
      .catch((err) => list.replaceChildren(loadError(err, load)));
  }
  load();
}

async function renderCustomer(root, id) {
  root.append(h("a", { class: "back", href: "#customers" }, "← All customers"));
  const body = h("div", {}, loading());
  root.append(body);
  const q = enc(id);
  const [profile, phones, subs, payments, credits, referral, partner] = await Promise.allSettled([
    rest(`profiles?id=eq.${q}&select=*`),
    rest(`user_phones?user_id=eq.${q}&select=phone,position,locked_until&order=position`),
    rest(`package_subscriptions?provider_id=eq.${q}&select=*&order=created_at.desc`),
    rest(`payment_orders?provider_id=eq.${q}&select=${PAYMENT_SELECT}&order=created_at.desc`),
    rest(`contact_credits?user_id=eq.${q}&select=balance`),
    rest(`referrals?referred_id=eq.${q}&select=code,status,created_at,partner:profiles!referrals_partner_id_fkey(id,full_name)`),
    rest(`partners?user_id=eq.${q}&select=code,status`),
  ]);
  const value = (r) => (r.status === "fulfilled" && r.value && r.value[0]) || null;
  const creditRow = value(credits), refRow = value(referral), partnerRow = value(partner);
  if (profile.status === "rejected") { body.replaceChildren(loadError(profile.reason, () => route())); return; }
  const c = profile.value && profile.value[0];
  if (!c) { body.replaceChildren(h("div", { class: "empty" }, "Customer not found.")); return; }

  const phoneList = phones.status === "fulfilled" && phones.value.length
    ? phones.value.map((p) => p.phone).join(", ")
    : c.phone || "—";

  const now = Date.now();
  const subRows = subs.status === "fulfilled" ? subs.value : [];
  const subsBlock = subs.status === "rejected" ? loadError(subs.reason)
    : !subRows.length ? h("div", { class: "table-wrap" }, h("div", { class: "empty" }, "No packages yet."))
    : h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Package"), h("th", {}, "Listings"), h("th", {}, "Customer numbers used"), h("th", {}, "Started"), h("th", {}, "Ends"), h("th", {}, "Status"))),
      h("tbody", {}, subRows.map((s) => {
        const active = s.status === "active" && new Date(s.expires_at).getTime() > now;
        return h("tr", {},
          h("td", {}, packageName(s.package_id)),
          h("td", {}, count(s.listing_allowance)),
          h("td", {}, s.contact_allowance == null
            ? "Unlimited"
            : `${count(s.contacts_used || 0)} of ${count(s.contact_allowance)}`),
          h("td", {}, fmtDate(s.starts_at, false)),
          h("td", {}, fmtDate(s.expires_at)),
          h("td", {}, h("span", { class: `badge ${active ? "ok" : "grey"}` }, active ? "Active" : "Expired")));
      }))));

  body.replaceChildren(
    h("div", { class: "card" },
      h("div", { class: "detail-head" },
        h("h2", {}, c.full_name || "—"),
        c.is_admin ? h("span", { class: "badge orange" }, "Admin") : null),
      h("dl", { class: "kv" },
        h("dt", {}, "Email"), h("dd", {}, c.email || "—"),
        h("dt", {}, "Phone"), h("dd", {}, phoneList),
        h("dt", {}, "Role"), h("dd", {}, roleLabel(c.role)),
        h("dt", {}, "Language"), h("dd", {}, c.default_language === "sw" ? "Swahili" : "English"),
        h("dt", {}, "Joined"), h("dd", {}, fmtDate(c.created_at)),
        h("dt", {}, "Credits"), h("dd", {}, count(creditRow?.balance || 0)),
        h("dt", {}, "Joined with code"), h("dd", {}, refRow
          ? [refRow.code, " · ", refRow.partner ? h("a", { href: `#partners/${enc(refRow.partner.id)}` }, refRow.partner.full_name || "partner") : "partner deleted",
             refRow.status === "void" ? [" ", h("span", { class: "badge grey" }, "Void")] : null]
          : "—"),
        h("dt", {}, "Partner"), h("dd", {}, partnerRow
          ? [h("a", { href: `#partners/${enc(c.id)}` }, partnerRow.code), " ", partnerStatusBadge(partnerRow.status)]
          : "No"),
        h("dt", {}, "User ID"), h("dd", { class: "small" }, c.id)),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn primary", type: "button", onclick: () => openOfferForm(null, [c]) }, "Give an offer"))),
    h("h2", {}, "Packages"),
    subsBlock,
    h("h2", {}, "Payments"),
    payments.status === "rejected" ? loadError(payments.reason) : paymentsTable(payments.value, false),
  );
}

// ── Packages & prices ─────────────────────────────────────────────────────

async function renderPackages(root) {
  root.append(h("div", { class: "note" },
    "Changes apply to new purchases only. People who already paid keep the listings and end date they bought. " +
    "The app and the website read these prices, and the server always charges the price set here."));
  const grid = h("div", { class: "packages" }, loading());
  root.append(grid);
  let rows;
  try {
    rows = await rest("package_catalog?select=*&order=sort_order");
  } catch (err) {
    grid.replaceChildren(loadError(err, () => route()));
    return;
  }
  const groups = [
    ["Subscriptions (unlimited connections)", rows.filter((r) => r.kind === "package" && r.contact_allowance == null)],
    ["Pay-as-you-go bundles (credits never expire)", rows.filter((r) => r.kind === "bundle")],
    ["Packages with a customer-number limit", rows.filter((r) => r.kind === "package" && r.contact_allowance != null)],
    ["Top-ups", rows.filter((r) => r.kind === "topup")],
  ].filter(([, list]) => list.length);
  grid.replaceWith(h("div", {}, groups.map(([title, list]) => [
    h("h2", {}, title),
    h("div", { class: "packages" }, list.map(packageEditor)),
  ])));
}

function packageEditor(pkg) {
  let saved = { ...pkg };
  const field = (label, value, attrs = {}) => {
    const input = h("input", { type: "number", inputmode: "numeric", value: String(value), ...attrs });
    return [input, h("label", {}, label, input)];
  };
  const [price, priceLabel] = field("Price (TZS)", pkg.amount, { min: "100", step: "100" });
  const [listings, listingsLabel] = field("Listings allowed", pkg.listing_allowance, { min: "1", max: "500" });
  const [days, daysLabel] = field("Duration (days)", pkg.validity_days, { min: "1", max: "730" });
  // A bundle sells connection credits (they never expire). A top-up adds
  // customer numbers to a running package. Neither gives listings or a
  // duration of its own.
  const bundle = pkg.kind === "bundle";
  const [contacts, contactsLabel] = field(bundle ? "Credits" : "Customer numbers", pkg.contact_allowance ?? "",
    { min: "1", max: "5000", placeholder: bundle ? "" : "Unlimited" });
  const topUp = pkg.kind === "topup" || bundle;
  priceLabel.classList.add("full");
  const active = h("input", { type: "checkbox" });
  active.checked = pkg.active !== false;
  const onSale = h("span", {}, "");
  const updateSaleLabel = () => { onSale.textContent = active.checked ? "On sale" : "Hidden from buyers"; };
  updateSaleLabel();
  const saveBtn = h("button", { class: "btn primary", type: "button", disabled: true }, "Save");
  const updated = h("span", { class: "muted small" }, `Updated ${fmtDate(pkg.updated_at)}`);

  const values = () => ({
    amount: Number(price.value.replace(/,/g, "").trim()),
    ...(topUp ? {} : {
      listing_allowance: Number(listings.value.trim()),
      validity_days: Number(days.value.trim()),
    }),
    // Empty = unlimited, only for packages that never had a limit.
    ...(contacts.value.trim() === "" && saved.contact_allowance == null
      ? {}
      : { contact_allowance: Number(contacts.value.trim()) }),
    active: active.checked,
  });
  const changed = () => {
    const v = values();
    return v.amount !== saved.amount ||
      (!topUp && (v.listing_allowance !== saved.listing_allowance || v.validity_days !== saved.validity_days)) ||
      ("contact_allowance" in v && v.contact_allowance !== saved.contact_allowance) ||
      v.active !== (saved.active !== false);
  };
  const refresh = () => { saveBtn.disabled = !changed(); updateSaleLabel(); };
  [price, listings, days, contacts].forEach((i) => i.addEventListener("input", refresh));
  active.addEventListener("change", refresh);

  saveBtn.addEventListener("click", async () => {
    const v = values();
    if (!Number.isInteger(v.amount) || v.amount < PESAPAL_MINIMUM) { toast(`Price must be a whole number of at least ${tzs(PESAPAL_MINIMUM)}: Pesapal can't take less.`, true); return; }
    if (!topUp && (!Number.isInteger(v.listing_allowance) || v.listing_allowance < 1 || v.listing_allowance > 500)) { toast("Listings must be between 1 and 500.", true); return; }
    if (!topUp && (!Number.isInteger(v.validity_days) || v.validity_days < 1 || v.validity_days > 730)) { toast("Duration must be between 1 and 730 days.", true); return; }
    if ("contact_allowance" in v && (!Number.isInteger(v.contact_allowance) || v.contact_allowance < 1 || v.contact_allowance > 5000)) { toast(`${bundle ? "Credits" : "Customer numbers"} must be between 1 and 5000.`, true); return; }
    if (!v.active && saved.active !== false) {
      const ok = await confirmDialog({
        title: `Stop selling ${packageName(pkg.id)}?`,
        body: "Buyers won't see this package in the app or on the website until you turn it back on. Current holders keep it until it ends.",
        confirmLabel: "Stop selling", danger: true,
      });
      if (!ok) return;
    }
    saveBtn.disabled = true;
    saveBtn.replaceChildren(h("span", { class: "spinner" }), "Saving");
    try {
      const rows = await rest(`package_catalog?id=eq.${enc(pkg.id)}`, {
        method: "PATCH", body: v, prefer: "return=representation",
      });
      if (!rows || !rows[0]) throw new ApiError("forbidden", 403, "Not allowed to change prices");
      saved = rows[0];
      updated.textContent = `Updated ${fmtDate(saved.updated_at)}`;
      toast(`${packageName(pkg.id)} saved.`);
    } catch (err) {
      toast(`Couldn't save. ${errorText(err)}`, true);
    } finally {
      saveBtn.replaceChildren("Save");
      refresh();
    }
  });

  const kindBadge = bundle ? h("span", { class: "badge blue" }, "Credits")
    : pkg.kind === "topup" ? h("span", { class: "badge grey" }, "Top-up")
    : pkg.contact_allowance == null ? h("span", { class: "badge orange" }, "Unlimited")
    : h("span", { class: "badge grey" }, "Limited");
  return h("div", { class: "card" },
    h("div", { class: "pkg-head" },
      h("div", { class: "pkg-title" }, h("h3", {}, packageName(pkg.id)), kindBadge),
      h("label", { class: "switch" }, onSale, active)),
    h("div", { class: "pkg-fields" }, priceLabel, ...(topUp ? [] : [listingsLabel, daysLabel]), contactsLabel),
    h("div", { class: "pkg-foot" }, updated, saveBtn));
}

// ── Offers ────────────────────────────────────────────────────────────────
//
// A percentage off one package or all of them, for everyone or for chosen
// customers, between two dates. The checkout always charges the best live
// offer for that buyer (package_prices_for in the database), so what's set
// here is exactly what people pay.

const OFFER_SELECT = "*,recipients:package_offer_recipients(count)";

function offersMissing(err) {
  return err && (err.status === 404 || /could not find the table/i.test(err.message || ""));
}

function offersNotLive() {
  return h("div", { class: "card" },
    h("h2", { style: { marginTop: "0" } }, "Offers aren't switched on in the database yet"),
    h("p", { class: "muted" },
      "The database update that adds offers (migration 20261103090000_package_admin_and_offers) " +
      "hasn't been applied to the live database. Once it is, you can create offers here."));
}

function offerState(o) {
  const now = Date.now();
  if (!o.active) return ["Paused", "grey"];
  if (o.ends_at && new Date(o.ends_at).getTime() <= now) return ["Ended", "grey"];
  if (new Date(o.starts_at).getTime() > now) return ["Scheduled", "warn"];
  return ["Live", "ok"];
}

/// Same rounding as the database: nearest TZS 100, never below TZS 100.
function offerPrice(amount, percentOff) {
  if (percentOff >= 100) return 0; // 100% off = free, claimed once per person
  return Math.max(100, Math.round((amount * (100 - percentOff)) / 10000) * 100);
}

async function renderOffers(root) {
  root.append(
    h("div", { class: "toolbar" },
      h("button", { class: "btn primary", type: "button", onclick: () => openOfferForm(null, []) }, "New offer")),
    h("p", { class: "muted small" },
      "Buyers automatically get the best live offer that applies to them, in the app and on the website. " +
      "Prices are rounded to the nearest TZS 100 and never go below TZS 100."));
  const list = h("div", {}, loading());
  root.append(list);
  let offers;
  try {
    offers = await rest(`package_offers?select=${OFFER_SELECT}&order=created_at.desc`);
  } catch (err) {
    list.replaceChildren(offersMissing(err) ? offersNotLive() : loadError(err, () => route()));
    return;
  }
  // How many people used each offer (paid with it, or claimed it free).
  const used = new Map();
  try {
    const orders = await rest("payment_orders?select=offer_id,status,amount&offer_id=not.is.null&limit=10000");
    for (const o of orders) if (o.status === "completed" || (num(o.amount) === 0 && o.status !== "failed")) used.set(o.offer_id, (used.get(o.offer_id) || 0) + 1);
  } catch (_) { /* the count is a nicety; the list still works */ }
  if (!offers.length) {
    list.replaceChildren(h("div", { class: "table-wrap" }, h("div", { class: "empty" }, "No offers yet. Create one with “New offer”.")));
    return;
  }
  list.replaceChildren(h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {},
      h("th", {}, "Offer"), h("th", {}, "Discount"), h("th", {}, "Who"), h("th", {}, "When"), h("th", {}, "Used"), h("th", {}, "Status"), h("th", {}, ""))),
    h("tbody", {}, offers.map((o) => {
      const [label, tone] = offerState(o);
      const recipients = num(o.recipients?.[0]?.count);
      return h("tr", { class: "click", onclick: (e) => { if (!e.target.closest("button")) openOfferForm(o); } },
        h("td", {}, o.title),
        h("td", {}, o.percent_off >= 100 ? "FREE (100% off)" : `${o.percent_off}% off`, h("div", { class: "sub" }, o.package_id ? packageName(o.package_id) : "All packages")),
        h("td", {}, o.audience === "selected" ? `${recipients} chosen customer${recipients === 1 ? "" : "s"}` : "Everyone"),
        h("td", {}, fmtDate(o.starts_at), h("div", { class: "sub" }, o.ends_at ? `until ${fmtDate(o.ends_at)}` : "no end date")),
        h("td", {}, `${used.get(o.id) || 0} ${o.max_claims ? `of ${o.max_claims}` : "people"}`, h("div", { class: "sub" }, o.max_claims ? "used so far" : "no limit")),
        h("td", {}, h("span", { class: `badge ${tone}` }, label)),
        h("td", { class: "num" },
          h("button", { class: "btn small", type: "button", onclick: () => setOfferActive(o, !o.active) }, o.active ? "Pause" : "Resume")));
    })))));
}

async function setOfferActive(o, active) {
  try {
    await rest(`package_offers?id=eq.${enc(o.id)}`, { method: "PATCH", body: { active } });
    toast(active ? "Offer resumed." : "Offer paused.");
    route();
  } catch (err) {
    toast(`Couldn't update. ${errorText(err)}`, true);
  }
}

/// For <input type="datetime-local">: the browser's local time, no seconds.
function toLocalInput(value) {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/// Create (offer = null) or edit an offer. [presetRecipients] pre-selects
/// customers, e.g. from a customer's page.
async function openOfferForm(offer, presetRecipients = []) {
  openModal(loading());
  const [catalogRes, recipientsRes] = await Promise.allSettled([
    loadCatalogNames(),
    offer && offer.audience === "selected"
      ? rest(`package_offer_recipients?offer_id=eq.${enc(offer.id)}&select=user:profiles(id,full_name,email,phone)`)
      : Promise.resolve([]),
  ]);
  const catalog = (catalogRes.status === "fulfilled" && catalogRes.value) || [];
  if (recipientsRes.status === "rejected") {
    openModal(offersMissing(recipientsRes.reason) ? offersNotLive() : loadError(recipientsRes.reason));
    return;
  }
  const chosen = new Map();
  for (const r of recipientsRes.value) if (r.user) chosen.set(r.user.id, r.user);
  for (const c of presetRecipients) chosen.set(c.id, c);

  const title = h("input", { type: "text", maxlength: "80", placeholder: "e.g. Launch week special", value: offer?.title || "" });
  const percent = h("input", { type: "number", min: "1", max: "100", step: "1", inputmode: "numeric", value: String(offer?.percent_off ?? 20) });
  const pkg = h("select", {},
    h("option", { value: "" }, "All packages"),
    catalog.map((c) => h("option", { value: c.id }, `${packageName(c.id)}${c.active === false ? " (not on sale)" : ""}`)));
  pkg.value = offer?.package_id || "";
  const starts = h("input", { type: "datetime-local", value: toLocalInput(offer?.starts_at || new Date()) });
  const ends = h("input", { type: "datetime-local", value: toLocalInput(offer?.ends_at) });
  const maxClaims = h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", placeholder: "No limit", value: offer?.max_claims ? String(offer.max_claims) : "" });
  const audience = h("select", {},
    h("option", { value: "all" }, "Everyone"),
    h("option", { value: "selected" }, "Only customers I choose"));
  audience.value = offer ? offer.audience : (presetRecipients.length ? "selected" : "all");
  const active = h("input", { type: "checkbox" });
  active.checked = offer ? offer.active !== false : true;

  // Price preview
  const preview = h("div", { class: "card offer-preview" });
  function drawPreview() {
    const p = Math.trunc(Number(percent.value));
    const rows = catalog.filter((c) => !pkg.value || c.id === pkg.value);
    if (!(p >= 1 && p <= 100) || !rows.length) { preview.replaceChildren(h("span", { class: "muted small" }, "Enter a discount between 1% and 100% to see the new prices.")); return; }
    preview.replaceChildren(h("div", { class: "chart-title" }, "New prices"), ...rows.map((c) => h("div", { class: "list-row" },
      h("span", {}, packageName(c.id)),
      h("span", {}, h("s", { class: "muted" }, tzs(c.amount)), "  ", h("b", {}, p >= 100 ? "FREE" : tzs(offerPrice(c.amount, p)))))),
      ...(p >= 100 ? [h("p", { class: "muted small" }, "100% off: each customer can claim it once, with no payment. Use it for gifts and launch promotions.")] : []));
  }
  [percent, pkg].forEach((el) => el.addEventListener("input", drawPreview));
  drawPreview();

  // Customer picker (only for "Only customers I choose")
  const chips = h("div", { class: "chips" });
  function drawChips() {
    chips.replaceChildren(...[...chosen.values()].map((c) => h("span", { class: "chip on" },
      c.full_name || c.email || c.phone || "Customer", " ",
      h("button", { type: "button", class: "chip-x", "aria-label": "Remove", onclick: () => { chosen.delete(c.id); drawChips(); } }, "×"))));
    if (!chosen.size) chips.append(h("span", { class: "muted small" }, "No customers chosen yet."));
  }
  const findInput = h("input", { type: "search", placeholder: "Search name, email or phone" });
  const results = h("div", { class: "picker-results" });
  const findBtn = h("button", { class: "btn", type: "button" }, "Find");
  async function find() {
    const q = findInput.value.trim().replace(/[,()%*\\:."']/g, "");
    if (!q) return;
    results.replaceChildren(loading());
    try {
      const rows = await rest(`profiles?select=id,full_name,email,phone&or=(${["full_name", "email", "phone"].map((f) => `${f}.ilike.*${enc(q)}*`).join(",")})&order=created_at.desc&limit=20`);
      results.replaceChildren(...(rows.length ? rows.map((c) => h("button", {
        type: "button", class: "picker-row",
        onclick: () => { chosen.set(c.id, c); drawChips(); },
      }, h("b", {}, c.full_name || "—"), h("span", { class: "muted small" }, [c.email, c.phone].filter(Boolean).join(" · ")))) : [h("div", { class: "muted small" }, "No one found.")]));
    } catch (err) {
      results.replaceChildren(h("div", { class: "error" }, errorText(err)));
    }
  }
  findBtn.addEventListener("click", find);
  findInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); find(); } });
  const picker = h("div", { class: "picker" },
    h("label", {}, "Customers who get this offer"), chips,
    h("div", { class: "picker-search" }, findInput, findBtn), results);
  const syncAudience = () => { picker.hidden = audience.value !== "selected"; };
  audience.addEventListener("change", syncAudience);
  drawChips();
  syncAudience();

  const error = h("p", { class: "error", hidden: true });
  const saveBtn = h("button", { class: "btn primary", type: "button" }, offer ? "Save changes" : "Create offer");
  saveBtn.addEventListener("click", async () => {
    const fail = (msg) => { error.textContent = msg; error.hidden = false; };
    error.hidden = true;
    const p = Number(percent.value);
    const start = starts.value ? new Date(starts.value) : new Date();
    const end = ends.value ? new Date(ends.value) : null;
    if (!title.value.trim()) return fail("Give the offer a name.");
    if (!Number.isInteger(p) || p < 1 || p > 100) return fail("The discount must be a whole number between 1% and 100%.");
    if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) return fail("Check the start and end dates.");
    if (end && end <= start) return fail("The end must be after the start.");
    if (audience.value === "selected" && !chosen.size) return fail("Choose at least one customer, or set “Who” to Everyone.");
    // Pesapal can't take less than TZS 1,000, so no offer may go below it.
    const affected = catalog.filter((c) => c.active !== false && num(c.amount) > 0 && (!pkg.value || c.id === pkg.value));
    // 100% off is free (no payment, so Pesapal's minimum doesn't apply).
    const tooCheap = p >= 100 ? null : affected.find((c) => Math.round(num(c.amount) * (100 - p) / 100) < PESAPAL_MINIMUM);
    if (tooCheap) {
      return fail(`${p}% off would make ${packageName(tooCheap.id)} cost ${tzs(Math.round(num(tooCheap.amount) * (100 - p) / 100))}. ` +
        `Pesapal can't take less than ${tzs(PESAPAL_MINIMUM)}: choose a smaller discount${pkg.value ? "" : " or one package"}.`);
    }

    const maxRaw = maxClaims.value.trim();
    const max = maxRaw === "" ? null : Number(maxRaw);
    if (max !== null && (!Number.isInteger(max) || max < 1)) return fail("“Maximum people” must be a whole number of 1 or more, or empty for no limit.");
    const body = {
      max_claims: max,
      title: title.value.trim(),
      package_id: pkg.value || null,
      percent_off: p,
      starts_at: start.toISOString(),
      ends_at: end ? end.toISOString() : null,
      audience: audience.value,
      active: active.checked,
    };
    saveBtn.disabled = true;
    saveBtn.replaceChildren(h("span", { class: "spinner" }), "Saving…");
    try {
      let id = offer?.id;
      if (id) {
        await rest(`package_offers?id=eq.${enc(id)}`, { method: "PATCH", body });
      } else {
        const rows = await rest("package_offers?select=id", { method: "POST", body, prefer: "return=representation" });
        id = rows[0].id;
      }
      // Set exactly who gets it.
      await rest(`package_offer_recipients?offer_id=eq.${enc(id)}`, { method: "DELETE" });
      if (audience.value === "selected") {
        await rest("package_offer_recipients", {
          method: "POST", body: [...chosen.keys()].map((u) => ({ offer_id: id, user_id: u })),
        });
      }
      toast(offer ? "Offer saved." : "Offer created.");
      if (location.hash === "#offers") route(); else location.hash = "offers";
    } catch (err) {
      fail(offersMissing(err) ? "Offers aren't switched on in the database yet." : `Couldn't save. ${errorText(err)}`);
      saveBtn.disabled = false;
      saveBtn.replaceChildren(offer ? "Save changes" : "Create offer");
    }
  });

  const deleteBtn = offer && h("button", { class: "btn danger", type: "button", onclick: async () => {
    const ok = await confirmDialog({
      title: `Delete “${offer.title}”?`,
      body: "Nobody will get this discount any more. Payments already made with it are not affected. To stop it for now and keep it for later, use Pause instead.",
      confirmLabel: "Delete offer", danger: true,
    });
    if (!ok) { openOfferForm(offer); return; }
    try {
      await rest(`package_offers?id=eq.${enc(offer.id)}`, { method: "DELETE" });
      toast("Offer deleted.");
      route();
    } catch (err) {
      toast(`Couldn't delete. ${errorText(err)}`, true);
    }
  } }, "Delete");

  openModal(
    h("h2", { style: { marginTop: "0" } }, offer ? "Edit offer" : "New offer"),
    h("div", { class: "form" },
      h("label", {}, "Name (shown to buyers)", title),
      h("div", { class: "pkg-fields" },
        h("label", {}, "Discount (%)", percent),
        h("label", {}, "Package", pkg),
        h("label", {}, "Starts", starts),
        h("label", {}, "Ends (leave empty for no end)", ends),
        h("label", {}, "Maximum people (leave empty for no limit)", maxClaims)),
      h("label", {}, "Who gets it", audience),
      picker,
      preview,
      h("label", { class: "switch" }, active, "Active (turn off to pause)"),
      error),
    h("div", { class: "modal-actions" },
      deleteBtn,
      h("button", { class: "btn", type: "button", onclick: closeModal }, "Cancel"),
      saveBtn));
}

// ── Insights ──────────────────────────────────────────────────────────────

async function renderInsights(root) {
  root.append(loading());
  let d;
  try {
    d = (await rpc("admin_insights")) || {};
  } catch (err) {
    root.replaceChildren(loadError(err, () => route()));
    return;
  }
  const u = d.users || {}, r = d.revenue || {}, n = d.needs || {}, l = d.listings || {}, c = d.contacts || {};
  const routes = d.top_routes || [];
  // h() flattens the optional sections below; replaceChildren() would not.
  root.replaceChildren(h("div", {},
    h("p", { class: "muted small" }, "Totals only — no names, phone numbers or emails are included in these reports."),
    h("h2", {}, "Users"),
    h("div", { class: "stats" },
      stat("Total", count(u.total)), stat("New today", count(u.today)),
      stat("Last 7 days", count(u.d7)), stat("Last 30 days", count(u.d30)),
      stat("Senders", count(u.senders)), stat("Providers", count(u.providers)), stat("Both", count(u.both))),
    h("h2", {}, "Revenue"),
    h("div", { class: "stats" },
      stat("All time", tzs(r.total), "money"), stat("Last 7 days", tzs(r.d7), "money"),
      stat("Last 30 days", tzs(r.d30), "money"), stat("Paid orders", count(r.orders)),
      stat("Paying customers", count(r.buyers))),
    h("h2", {}, "Last 30 days"),
    h("div", { class: "grid2" },
      barChart("New sign-ups per day", d.signups_daily || [], "n", count),
      barChart("Revenue per day", d.revenue_daily || [], "amount", tzs)),
    (d.revenue_by_package || []).length ? [h("h2", {}, "Revenue by package"), packageRevenue(d.revenue_by_package)] : null,
    h("h2", {}, "Marketplace"),
    h("div", { class: "stats" },
      stat("Open requests", count(n.open)), stat("Deals closed", count(n.closed)),
      stat("Live vehicles", count(l.live)), stat("Hidden vehicles", count(l.hidden)),
      stat("Removed by admin", count(num(n.removed) + num(l.removed)))),
    h("h2", {}, "Contacts opened"),
    h("div", { class: "stats" },
      stat("Last 7 days", count(c.d7)), stat("Last 30 days", count(c.d30)),
      stat("People (30 days)", count(c.people_d30))),
    h("p", { class: "muted small" }, "Each time someone opens another person's phone number."),
    routes.length ? [
      h("h2", {}, "Top routes people need"),
      h("div", { class: "card" }, routes.map((x) => h("div", { class: "list-row" }, h("span", {}, x.route || "—"), h("b", {}, count(x.n))))),
    ] : null,
  ));
}

function barChart(title, points, key, format) {
  const values = points.map((p) => num(p[key]));
  const max = Math.max(0, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const caption = h("div", { class: "chart-caption" }, `${format(total)} total`);
  const bars = points.map((p, i) => {
    const bar = h("div", {
      class: "bar", title: `${fmtDate(p.day, false)}: ${format(values[i])}`,
      style: { height: `${max ? Math.max(3, (values[i] / max) * 100) : 3}%` },
    });
    const select = () => {
      bars.forEach((b) => b.classList.remove("on"));
      bar.classList.add("on");
      caption.textContent = `${fmtDate(p.day, false)} · ${format(values[i])}`;
    };
    bar.addEventListener("mouseenter", select);
    bar.addEventListener("click", select);
    return bar;
  });
  const chart = h("div", { class: "bars" }, bars);
  chart.addEventListener("mouseleave", () => {
    bars.forEach((b) => b.classList.remove("on"));
    caption.textContent = `${format(total)} total`;
  });
  return h("div", { class: "card" },
    h("div", { class: "chart-title" }, title), caption, chart,
    points.length ? h("div", { class: "chart-axis" },
      h("span", {}, fmtDate(points[0].day, false)), h("span", {}, fmtDate(points[points.length - 1].day, false))) : null);
}

function packageRevenue(rows) {
  const max = Math.max(1, ...rows.map((r) => num(r.amount)));
  return h("div", { class: "card" }, rows.map((r) => h("div", { class: "hbar" },
    h("div", { class: "hbar-row" },
      h("span", {}, packageName(r.package)),
      h("span", { class: "muted" }, `${tzs(r.amount)} · ${count(r.orders)} order${num(r.orders) === 1 ? "" : "s"}`)),
    h("div", { class: "hbar-track" }, h("div", { class: "hbar-fill", style: { width: `${(num(r.amount) / max) * 100}%` } })))));
}

// ── Posts (moderation) ────────────────────────────────────────────────────

function postStatus(status) {
  return {
    active: "Live", paused: "Hidden by owner", cancelled: "Cancelled",
    fulfilled: "Deal closed", expired: "Expired", completed: "Completed",
  }[status] || status || "—";
}

const postsState = { kind: "need" };

function renderPosts(root) {
  const kinds = [["need", "Transport requests"], ["listing", "Vehicles"]];
  root.append(
    h("div", { class: "toolbar" }, h("div", { class: "chips" }, kinds.map(([k, label]) => h("button", {
      type: "button", class: `chip ${postsState.kind === k ? "on" : ""}`,
      onclick: () => { postsState.kind = k; route(); },
    }, label)))),
    h("p", { class: "muted small" }, "Latest 100 posts. Posters are shown by an anonymous tag only. Removing a post hides it from everyone; you can restore it later."),
  );
  const list = h("div", {}, loading());
  root.append(list);

  const kind = postsState.kind;
  function load() {
    rpc("admin_recent_posts", { p_kind: kind, p_limit: 100 })
      .then((posts) => {
        posts = posts || [];
        if (!posts.length) { list.replaceChildren(h("div", { class: "table-wrap" }, h("div", { class: "empty" }, "Nothing here yet."))); return; }
        list.replaceChildren(h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, kind === "need" ? "Request" : "Vehicle"), h("th", {}, "Route"), h("th", {}, "Posted"), h("th", {}, "Status"), h("th", {}, ""))),
          h("tbody", {}, posts.map((p) => h("tr", {},
            h("td", {}, p.title || "—", h("div", { class: "sub" }, `#${p.poster || "?"}`)),
            h("td", {}, p.route || "—"),
            h("td", {}, fmtDate(p.created_at)),
            h("td", {}, p.moderated
              ? h("span", { class: "badge bad" }, "Removed")
              : h("span", { class: `badge ${p.status === "active" ? "ok" : "grey"}` }, postStatus(p.status))),
            h("td", { class: "num" }, p.moderated
              ? h("button", { class: "btn small", type: "button", onclick: () => moderate(p, false) }, "Restore")
              : h("button", { class: "btn small danger", type: "button", onclick: () => moderate(p, true) }, "Remove"))))))));
      })
      .catch((err) => list.replaceChildren(loadError(err, load)));
  }

  async function moderate(post, remove) {
    if (remove) {
      const ok = await confirmDialog({
        title: "Remove this post?",
        body: "It will be hidden from everyone in the app. You can restore it later from this page.",
        confirmLabel: "Remove", danger: true,
      });
      if (!ok) return;
    }
    try {
      await rpc("admin_moderate_post", { p_kind: kind, p_id: post.id, p_remove: remove });
      toast(remove ? "Post removed." : "Post restored.");
      load();
    } catch (err) {
      toast(`Couldn't update. ${errorText(err)}`, true);
    }
  }
  load();
}

// ── Business (the business plan's numbers) ────────────────────────────────

const businessState = { days: 30 };

function partnerStatusBadge(status) {
  return status === "suspended"
    ? h("span", { class: "badge bad" }, "Suspended")
    : h("span", { class: "badge ok" }, "Active");
}

function migrationMissing(err) {
  return err && (err.status === 404 || /could not find|does not exist/i.test(err.message || ""));
}

function planNotLive() {
  return h("div", { class: "card" },
    h("h2", { style: { marginTop: "0" } }, "The business-plan update isn't in the database yet"),
    h("p", { class: "muted" },
      "Apply migration 20261122090000_business_plan (supabase db push) to switch on subscriptions, " +
      "credit bundles, partners, payouts and these reports."));
}

async function renderBusiness(root) {
  const periods = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "12 months"]];
  root.append(h("div", { class: "toolbar" }, h("div", { class: "chips" }, periods.map(([d, label]) => h("button", {
    type: "button", class: `chip ${businessState.days === d ? "on" : ""}`,
    onclick: () => { businessState.days = d; route(); },
  }, label)))));
  const body = h("div", {}, loading());
  root.append(body);
  let b;
  try {
    b = (await rpc("admin_business_report", { p_days: businessState.days })) || {};
  } catch (err) {
    body.replaceChildren(migrationMissing(err) ? planNotLive() : loadError(err, () => route()));
    return;
  }
  const r = b.revenue || {}, c = b.commissions || {}, u = b.users || {}, w = b.watch || {};
  const retention = num(r.net) - num(c.earned);
  const conn = b.connections || {}, paidBy = conn.paid_by || {};

  const mix = [
    ["Subscriptions", r.subscriptions], ["Credit bundles", r.bundles],
    ["Limited packages", r.packages], ["Top-ups", r.topups],
  ].map(([label, amount]) => ({ label, amount: num(amount) }));

  const connRows = [
    ["Unlimited package", paidBy.unlimited], ["Package with a limit", paidBy.package],
    ["Credit", paidBy.credit], ["Free: opened before", paidBy.repeat],
    ["Free: replying to someone", paidBy.connection], ["Before the plan", paidBy.before_plan],
  ].filter(([, n]) => num(n) > 0).map(([label, n]) => ({ label, amount: num(n) }));

  const watchItems = [
    [num(w.shared_phone_referrals), "referrals share a phone number with their partner (same person?)", "#partners"],
    [num(w.refunds_period), `refund${num(w.refunds_period) === 1 ? "" : "s"} in this period`, "#payments"],
    [num(w.fair_use_hits), "people near the daily fair-use limit right now", null],
    [(w.busy_payers || []).length, "payer accounts paying for 3+ referred people", null],
  ].filter(([n]) => n > 0);

  body.replaceChildren(h("div", {},
    h("p", { class: "muted small" }, `Real payments only (test payments left out). Last ${businessState.days === 365 ? "12 months" : `${businessState.days} days`}, Tanzania time.`),
    h("div", { class: "stats" },
      stat("Revenue (after refunds)", tzs(r.net), "money"),
      stat("Partner commissions", tzs(c.earned), "money"),
      stat("Kept by TeleTransit", tzs(retention), "money"),
      stat("Refunded", tzs(r.refunded), num(r.refunded) ? "bad" : ""),
      stat("Paid orders", count(r.orders))),
    h("p", { class: "muted small" }, "“Kept by TeleTransit” is revenue minus partner commissions — before hosting, payment charges, taxes and other costs."),

    h("h2", {}, "Every day"),
    h("div", { class: "grid2" },
      barChart("Revenue per day", b.daily || [], "revenue", tzs),
      barChart("Partner commission per day", b.daily || [], "commission", tzs)),

    h("div", { class: "grid2", style: { marginTop: "14px" } },
      h("div", {}, h("h2", {}, "Where revenue comes from"), hbars(mix, tzs, "No revenue in this period yet.")),
      h("div", {}, h("h2", {}, "How numbers were opened"), hbars(connRows, count, "No numbers opened in this period."))),

    h("h2", {}, "People"),
    h("div", { class: "stats" },
      stat("Paying customers (all time)", count(u.paying)),
      stat("Bought more than once", count(u.repeat)),
      stat("New sign-ups", count(u.new)),
      stat("On an unlimited package now", count(u.active_unlimited)),
      stat("Holding credits", count(u.credit_holders)),
      stat("Credits not yet used", count(u.credits_outstanding))),

    h("h2", {}, "Partners"),
    h("div", { class: "stats" },
      linkStat("Active partners", count(u.partners), "#partners"),
      stat("New partners", count(u.partners_new)),
      stat("Referred users", count(u.referred)),
      stat("Referred in this period", count(u.referred_new)),
      linkStat("Owed to partners now", tzs(c.owed), "#partners", "money"),
      linkStat("Payouts waiting", `${count(c.waiting_count)} · ${tzs(c.waiting_payout)}`, "#payouts", num(c.waiting_count) ? "warn" : ""),
      stat("Paid out in this period", tzs(c.paid_out), "money")),

    h("h2", {}, "Watch list"),
    watchItems.length
      ? h("div", { class: "card" }, watchItems.map(([n, text, href]) => h("div", { class: "list-row" },
          h("span", {}, h("b", {}, count(n)), " ", text),
          href ? h("a", { href }, "Look") : h("span", {}))),
          (w.busy_payers || []).map((x) => h("div", { class: "list-row small" },
            h("span", { class: "muted" }, `Payer account …${x.payer_account}`),
            h("span", {}, `${count(x.people)} people · ${count(x.orders)} orders`))))
      : h("div", { class: "card muted" }, "Nothing unusual right now."),

    (b.refunds || []).length ? [
      h("h2", {}, "Latest refunds"),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "Customer"), h("th", {}, "Bought"), h("th", { class: "num" }, "Amount"), h("th", {}, "Reason"))),
        h("tbody", {}, b.refunds.map((f) => h("tr", {},
          h("td", {}, fmtDate(f.created_at)),
          h("td", {}, f.full_name || "—"),
          h("td", {}, packageName(f.package_id), h("div", { class: "sub" }, f.receipt_number || "")),
          h("td", { class: "num" }, tzs(f.amount)),
          h("td", {}, f.reason)))))),
    ] : null,
  ));
}

/// Horizontal bars for one measure across a few labelled categories.
function hbars(rows, format, emptyText) {
  const total = rows.reduce((a, r) => a + r.amount, 0);
  if (!total) return h("div", { class: "card muted" }, emptyText);
  const max = Math.max(...rows.map((r) => r.amount));
  return h("div", { class: "card" }, rows.map((r) => h("div", { class: "hbar", title: `${r.label}: ${format(r.amount)}` },
    h("div", { class: "hbar-row" },
      h("span", {}, r.label),
      h("span", { class: "muted" }, `${format(r.amount)} · ${Math.round((r.amount / total) * 100)}%`)),
    h("div", { class: "hbar-track" }, h("div", { class: "hbar-fill", style: { width: `${(r.amount / max) * 100}%` } })))));
}

// ── Partners ──────────────────────────────────────────────────────────────

const partnersState = { search: "" };

async function renderPartners(root, id) {
  if (id) { renderPartner(root, id); return; }
  const search = h("input", { type: "search", value: partnersState.search, placeholder: "Search name, email, phone or code" });
  const list = h("div", {}, loading());
  root.append(
    h("div", { class: "toolbar" }, search),
    h("p", { class: "muted small" },
      "Partners earn a share of what the people who joined with their code pay. Earnings wait for the refund window, then can be withdrawn."),
    list);
  let rows;
  try {
    rows = (await rpc("admin_partners")) || [];
  } catch (err) {
    list.replaceChildren(migrationMissing(err) ? planNotLive() : loadError(err, () => route()));
    return;
  }
  function draw() {
    const q = partnersState.search.trim().toLowerCase();
    const shown = !q ? rows : rows.filter((p) => [p.full_name, p.email, p.phone, p.code]
      .some((v) => v && String(v).toLowerCase().includes(q)));
    if (!shown.length) { list.replaceChildren(h("div", { class: "table-wrap" }, h("div", { class: "empty" }, rows.length ? "No partner matches." : "No partners yet. People join from the app (Profile → Business partner)."))); return; }
    const totals = shown.reduce((t, p) => ({
      earned: t.earned + num(p.earned_total), available: t.available + Math.max(0, num(p.available)),
      pending: t.pending + num(p.pending), paid: t.paid + num(p.paid_out),
    }), { earned: 0, available: 0, pending: 0, paid: 0 });
    list.replaceChildren(
      h("div", { class: "stats", style: { marginBottom: "14px" } },
        stat("Partners", count(shown.length)),
        stat("Earned", tzs(totals.earned), "money"),
        stat("In refund window", tzs(totals.pending)),
        stat("Can be withdrawn", tzs(totals.available), "money"),
        stat("Paid out", tzs(totals.paid))),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "Partner"), h("th", {}, "Code"), h("th", { class: "num" }, "Referred"), h("th", { class: "num" }, "Paying"), h("th", { class: "num" }, "Level"),
          h("th", { class: "num" }, "Earned"), h("th", { class: "num" }, "Available"), h("th", { class: "num" }, "Paid out"), h("th", {}, "Status"))),
        h("tbody", {}, shown.map((p) => h("tr", { class: "click", onclick: () => { location.hash = `partners/${enc(p.user_id)}`; } },
          h("td", {}, p.full_name || "—", h("div", { class: "sub" }, p.phone || p.email || "")),
          h("td", {}, h("code", {}, p.code)),
          h("td", { class: "num" }, count(p.referrals)),
          h("td", { class: "num" }, count(p.paying)),
          h("td", { class: "num" }, p.rate_bp == null ? "—" : h("b", {}, percentOf(p.rate_bp))),
          h("td", { class: "num" }, tzs(p.earned_total), num(p.reversed) ? h("div", { class: "sub" }, `${count(p.reversed)} reversed`) : null),
          h("td", { class: "num" }, h("span", { class: num(p.available) < 0 ? "neg" : "" }, tzs(p.available)),
            num(p.pending) ? h("div", { class: "sub" }, `+${tzs(p.pending)} waiting`) : null),
          h("td", { class: "num" }, tzs(p.paid_out)),
          h("td", {}, partnerStatusBadge(p.status))))))));
  }
  search.addEventListener("input", () => { partnersState.search = search.value; draw(); });
  draw();
  root.append(h("h2", {}, "Latest partner earnings"), await latestEarnings());
}

/// The newest commissions across all partners: who earned, from whom, how much.
async function latestEarnings() {
  let rows;
  try {
    rows = await rest("partner_commissions?select=*,partner:profiles!partner_commissions_partner_id_fkey(full_name),buyer:profiles!partner_commissions_referred_id_fkey(full_name)&order=created_at.desc&limit=25");
  } catch (err) {
    return loadError(err, () => route());
  }
  if (!rows || !rows.length) return h("div", { class: "table-wrap" }, h("div", { class: "empty" }, "No earnings yet. They appear here as soon as someone who joined with a code pays."));
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {},
      h("th", {}, "When"), h("th", {}, "Partner"), h("th", {}, "Bought by"), h("th", {}, "Package"),
      h("th", { class: "num" }, "Paid"), h("th", { class: "num" }, "Rate"), h("th", { class: "num" }, "Earned"))),
    h("tbody", {}, rows.map((c) => h("tr", { class: "click", onclick: () => { location.hash = `partners/${enc(c.partner_id)}`; } },
      h("td", {}, fmtDate(c.created_at)),
      h("td", {}, c.partner?.full_name || "—"),
      h("td", {}, c.buyer?.full_name || "—"),
      h("td", {}, packageName(c.package_id)),
      h("td", { class: "num" }, tzs(c.order_amount)),
      h("td", { class: "num" }, percentOf(c.rate_bp)),
      h("td", { class: "num" }, c.status === "reversed" ? h("s", {}, tzs(c.amount)) : h("b", {}, tzs(c.amount))))))));
}

/// 500 -> "5%", 1250 -> "12.5%".
function percentOf(bp) {
  return `${Number((num(bp) / 100).toFixed(2))}%`;
}

async function renderPartner(root, id) {
  root.append(h("a", { class: "back", href: "#partners" }, "← All partners"));
  const body = h("div", {}, loading());
  root.append(body);
  let d;
  try {
    d = await rpc("admin_partner_detail", { p_partner: id });
  } catch (err) {
    body.replaceChildren(loadError(err, () => route()));
    return;
  }
  const p = d && d.partner;
  if (!p) { body.replaceChildren(h("div", { class: "empty" }, "This person isn't a partner.")); return; }
  const bal = p.balance || {};
  const suspended = p.status === "suspended";

  const toggle = h("button", { class: `btn ${suspended ? "primary" : "danger"}`, type: "button" }, suspended ? "Reactivate" : "Suspend partner");
  toggle.addEventListener("click", async () => {
    let reason = null;
    if (!suspended) {
      reason = await promptDialog({
        title: `Suspend ${p.full_name || "this partner"}?`,
        body: "While suspended they earn nothing new and can't withdraw. What they already earned stays on record. You can reactivate them later.",
        label: "Reason (shown to admins only)", confirmLabel: "Suspend", danger: true,
      });
      if (reason == null) return;
    }
    try {
      await rpc("admin_set_partner_status", { p_partner: id, p_status: suspended ? "active" : "suspended", p_reason: reason });
      toast(suspended ? "Partner reactivated." : "Partner suspended.");
      route();
    } catch (err) { toast(`Couldn't update. ${errorText(err)}`, true); }
  });

  async function voidReferral(r) {
    const reason = await promptDialog({
      title: `Stop ${r.full_name || "this person"} earning for the partner?`,
      body: "The referral is voided: future purchases earn nothing. Commissions from them that weren't paid out yet are reversed too.",
      label: "Reason", confirmLabel: "Void referral", danger: true,
    });
    if (reason == null) return;
    try {
      await rpc("admin_void_referral", { p_referred: r.referred_id, p_reason: reason, p_reverse: true });
      toast("Referral voided.");
      route();
    } catch (err) { toast(`Couldn't void. ${errorText(err)}`, true); }
  }

  async function reverse(c) {
    const reason = await promptDialog({
      title: `Reverse ${tzs(c.amount)}?`,
      body: "The partner won't be paid this commission. If it was already paid out, it comes off their next earnings.",
      label: "Reason", confirmLabel: "Reverse", danger: true,
    });
    if (reason == null) return;
    try {
      await rpc("admin_reverse_commission", { p_id: c.id, p_reason: reason });
      toast("Commission reversed.");
      route();
    } catch (err) { toast(`Couldn't reverse. ${errorText(err)}`, true); }
  }

  const now = Date.now();
  const referrals = d.referrals || [], commissions = d.commissions || [], withdrawals = d.withdrawals || [];
  body.replaceChildren(
    h("div", { class: "card" },
      h("div", { class: "detail-head" },
        h("div", {}, h("h2", {}, p.full_name || "—"), h("div", { class: "muted" }, "Code ", h("code", {}, p.code))),
        partnerStatusBadge(p.status)),
      h("dl", { class: "kv" },
        h("dt", {}, "Email"), h("dd", {}, p.email || "—"),
        h("dt", {}, "Phone"), h("dd", {}, p.phone || "—"),
        h("dt", {}, "Partner since"), h("dd", {}, fmtDate(p.created_at)),
        suspended ? [h("dt", {}, "Suspended because"), h("dd", {}, p.status_reason || "—")] : null),
      h("div", { class: "modal-actions" },
        h("a", { class: "btn", href: `#customers/${enc(id)}` }, "Customer page"), toggle)),
    h("div", { class: "stats", style: { marginTop: "14px" } },
      stat("Can be withdrawn", tzs(bal.available), num(bal.available) < 0 ? "bad" : "money"),
      stat("In refund window", tzs(bal.pending)),
      stat("Earned (all time)", tzs(bal.earned_total), "money"),
      stat("Being paid out", tzs(bal.in_progress), num(bal.in_progress) ? "warn" : ""),
      stat("Paid out", tzs(bal.paid_out))),

    h("h2", {}, `People who joined with ${p.code}`),
    !referrals.length ? h("div", { class: "table-wrap" }, h("div", { class: "empty" }, "No one yet.")) :
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Person"), h("th", {}, "Joined"), h("th", { class: "num" }, "Spent"), h("th", {}, "Status"), h("th", {}, ""))),
      h("tbody", {}, referrals.map((r) => h("tr", {},
        h("td", {}, h("a", { href: `#customers/${enc(r.referred_id)}` }, r.full_name || "—"),
          h("div", { class: "sub" }, r.phone || r.email || ""),
          r.shared_phone ? h("div", {}, h("span", { class: "badge warn" }, "Shares a phone number")) : null),
        h("td", {}, fmtDate(r.created_at), h("div", { class: "sub" }, r.source === "signup" ? "at sign-up" : "code entered later")),
        h("td", { class: "num" }, tzs(r.spent)),
        h("td", {}, r.status === "void" ? h("span", { class: "badge grey", title: r.void_reason || "" }, "Void") : h("span", { class: "badge ok" }, "Counts")),
        h("td", { class: "num" }, r.status === "void" ? null : h("button", { class: "btn small danger", type: "button", onclick: () => voidReferral(r) }, "Void"))))))),

    h("h2", {}, "Commissions"),
    !commissions.length ? h("div", { class: "table-wrap" }, h("div", { class: "empty" }, "No commissions yet.")) :
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "From"), h("th", {}, "Bought"), h("th", { class: "num" }, "Paid"), h("th", { class: "num" }, "Commission"), h("th", {}, "Status"), h("th", {}, ""))),
      h("tbody", {}, commissions.map((c) => {
        const reversed = c.status === "reversed";
        const waiting = !reversed && new Date(c.available_at).getTime() > now;
        return h("tr", {},
          h("td", {}, fmtDate(c.created_at)),
          h("td", {}, c.referred_name || "—"),
          h("td", {}, packageName(c.package_id), h("div", { class: "sub" }, c.receipt_number || "")),
          h("td", { class: "num" }, tzs(c.order_amount)),
          h("td", { class: "num" }, tzs(c.amount), h("div", { class: "sub" }, `${num(c.rate_bp) / 100}%`)),
          h("td", {}, reversed ? h("span", { class: "badge grey", title: c.reversed_reason || "" }, "Reversed")
            : waiting ? h("span", { class: "badge warn" }, `Until ${fmtDate(c.available_at, false)}`)
            : h("span", { class: "badge ok" }, "Available")),
          h("td", { class: "num" }, reversed ? null : h("button", { class: "btn small danger", type: "button", onclick: () => reverse(c) }, "Reverse")));
      })))),

    h("h2", {}, "Withdrawals"),
    withdrawalsTable(withdrawals, false),
  );
}

/// A small form dialog: resolves to the trimmed text, or null if cancelled.
function promptDialog({ title, body, label, confirmLabel, danger, placeholder, required = true }) {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", maxlength: "300", placeholder: placeholder || "" });
    const error = h("p", { class: "error", hidden: true });
    const done = (v) => { closeModal(); resolve(v); };
    const ok = () => {
      const v = input.value.trim();
      if (required && v.length < 3) { error.textContent = "Please write at least a few words."; error.hidden = false; return; }
      done(v);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok(); } });
    openModal(
      h("h2", { style: { marginTop: "0" } }, title),
      h("p", { class: "muted" }, body),
      h("div", { class: "form" }, h("label", {}, label, input), error),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", type: "button", onclick: () => done(null) }, "Cancel"),
        h("button", { class: `btn ${danger ? "danger solid" : "primary"}`, type: "button", onclick: ok }, confirmLabel)));
    setTimeout(() => input.focus(), 0);
  });
}

// ── Payouts ───────────────────────────────────────────────────────────────

const payoutsState = { status: "requested" };

function withdrawalBadge(status) {
  const map = {
    requested: ["Waiting for you", "warn"], processing: ["Sending", "blue"], paid: ["Paid", "ok"],
    failed: ["Didn't go through", "bad"], rejected: ["Rejected", "bad"], cancelled: ["Cancelled by partner", "grey"],
  };
  const [label, tone] = map[status] || [status, "grey"];
  return h("span", { class: `badge ${tone}` }, label);
}

const NETWORKS = { Mpesa: "M-Pesa", Tigo: "Mixx by Yas", Airtel: "Airtel Money", Halopesa: "Halopesa", Azampesa: "AzamPesa" };

function withdrawalsTable(rows, withPartner, onOpen) {
  if (!rows.length) return h("div", { class: "table-wrap" }, h("div", { class: "empty" }, "No withdrawals here."));
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {},
      h("th", {}, "Requested"), withPartner && h("th", {}, "Partner"), h("th", {}, "Send to"),
      h("th", { class: "num" }, "Amount"), h("th", {}, "Status"), h("th", {}, "Reference"))),
    h("tbody", {}, rows.map((w) => h("tr", { class: onOpen ? "click" : "", onclick: onOpen ? () => onOpen(w) : null },
      h("td", {}, fmtDate(w.requested_at)),
      withPartner && h("td", {}, w.full_name || "—", h("div", { class: "sub" }, w.code || "")),
      h("td", {}, `+${w.phone}`, h("div", { class: "sub" }, NETWORKS[w.network] || w.network)),
      h("td", { class: "num" }, tzs(w.amount)),
      h("td", {}, withdrawalBadge(w.status), w.provider_message ? h("div", { class: "sub" }, w.provider_message) : null),
      h("td", {}, h("code", {}, w.reference), w.provider_reference ? h("div", { class: "sub" }, w.provider_reference) : null))))));
}

async function renderPayouts(root) {
  const filters = [["requested", "Waiting for you"], ["processing", "Sending"], ["paid", "Paid"], ["failed", "Didn't go through"], ["rejected", "Rejected"], [null, "All"]];
  const setup = h("div", {});
  const list = h("div", {}, loading());
  root.append(
    setup,
    h("div", { class: "toolbar" }, h("div", { class: "chips" }, filters.map(([v, label]) => h("button", {
      type: "button", class: `chip ${payoutsState.status === v ? "on" : ""}`,
      onclick: () => { payoutsState.status = v; route(); },
    }, label)))),
    list);

  edgeGet("partner-payout")
    .then((s) => {
      setup.replaceChildren(s && s.configured
        ? h("div", { class: "note ok" }, "AzamPay payouts are set up: “Send with AzamPay” sends the money to the partner's phone.")
        : h("div", { class: "note" },
            "AzamPay payouts aren't set up yet, so “Send with AzamPay” won't work. You can still pay partners yourself and record it with “Mark as paid”. ",
            s && s.missing && s.missing.length ? h("span", { class: "small" }, `Missing: ${s.missing.join(", ")}.`) : null));
    })
    .catch(() => setup.replaceChildren(h("div", { class: "note" },
      "Couldn't check the AzamPay payout setup (the partner-payout function may not be deployed yet). “Mark as paid” still works.")));

  let rows;
  try {
    rows = (await rpc("admin_withdrawals", { p_status: payoutsState.status })) || [];
  } catch (err) {
    list.replaceChildren(migrationMissing(err) ? planNotLive() : loadError(err, () => route()));
    return;
  }
  const total = rows.reduce((t, w) => t + num(w.amount), 0);
  list.replaceChildren(
    h("p", { class: "muted small" }, `${rows.length} withdrawal${rows.length === 1 ? "" : "s"} · ${tzs(total)}`),
    withdrawalsTable(rows, true, openWithdrawal));
}

function openWithdrawal(w) {
  const busy = (btn, text) => { btn.disabled = true; btn.replaceChildren(h("span", { class: "spinner" }), text); };
  const actions = [];

  if (w.status === "requested") {
    const send = h("button", { class: "btn primary", type: "button" }, "Send with AzamPay");
    send.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: `Send ${tzs(w.amount)} to +${w.phone}?`,
        body: `AzamPay sends it to ${NETWORKS[w.network] || w.network} for ${w.full_name || "the partner"}. This can't be undone.`,
        confirmLabel: "Send money",
      });
      if (!ok) { openWithdrawal(w); return; }
      openModal(loading());
      try {
        const r = await edgeFunction("partner-payout", { withdrawalId: w.id, action: "send" });
        toast(r.status === "failed" ? `AzamPay refused it: ${r.message}` : "Sent to AzamPay. It's marked paid once AzamPay confirms.", r.status === "failed");
      } catch (err) {
        toast(err.message && err.message !== "server" ? err.message : errorText(err), true);
      }
      route();
    });
    actions.push(send);
  }
  if (w.status === "processing") {
    const check = h("button", { class: "btn primary", type: "button" }, "Check status with AzamPay");
    check.addEventListener("click", async () => {
      busy(check, "Checking…");
      try {
        const r = await edgeFunction("partner-payout", { withdrawalId: w.id, action: "check" });
        toast(r.status === "paid" ? "Paid." : r.status === "failed" ? "It didn't go through. The money is back in the partner's balance." : `Still sending: ${r.message}`);
      } catch (err) {
        toast(err.message && err.message !== "server" ? err.message : errorText(err), true);
      }
      route();
    });
    actions.push(check);
  }
  if (["requested", "processing", "failed"].includes(w.status)) {
    const paid = h("button", { class: "btn", type: "button" }, "Mark as paid");
    paid.addEventListener("click", async () => {
      const ref = await promptDialog({
        title: `Record ${tzs(w.amount)} as paid`,
        body: `Only if the money reached +${w.phone}. Enter the mobile-money transaction ID from your phone or the AzamPay portal.`,
        label: "Transaction ID", placeholder: "e.g. QK41ABC9XY", confirmLabel: "Mark as paid",
      });
      if (ref == null) { openWithdrawal(w); return; }
      try {
        await rpc("admin_settle_withdrawal", { p_id: w.id, p_action: "paid", p_reference: ref, p_note: null });
        toast("Recorded as paid.");
        route();
      } catch (err) { toast(`Couldn't record it. ${errorText(err)}`, true); }
    });
    actions.push(paid);
  }
  if (["requested", "processing"].includes(w.status)) {
    const reject = h("button", { class: "btn danger", type: "button" }, w.status === "requested" ? "Reject" : "Mark as failed");
    reject.addEventListener("click", async () => {
      const note = await promptDialog({
        title: w.status === "requested" ? "Reject this withdrawal?" : "Mark as failed?",
        body: w.status === "requested"
          ? "Nothing is sent and the money stays in the partner's balance. The partner sees your reason."
          : "Only if you're sure the money did NOT arrive. It goes back to the partner's balance.",
        label: "Reason", confirmLabel: w.status === "requested" ? "Reject" : "Mark as failed", danger: true,
      });
      if (note == null) { openWithdrawal(w); return; }
      try {
        await rpc("admin_settle_withdrawal", { p_id: w.id, p_action: w.status === "requested" ? "reject" : "failed", p_reference: null, p_note: note });
        toast("Updated.");
        route();
      } catch (err) { toast(`Couldn't update. ${errorText(err)}`, true); }
    });
    actions.push(reject);
  }

  const lowBalance = w.status === "requested" && num(w.balance_after) < 0;
  openModal(
    h("div", { class: "detail-head" },
      h("div", {}, h("h2", {}, tzs(w.amount)), h("div", { class: "muted" }, w.full_name || "—")),
      withdrawalBadge(w.status)),
    lowBalance ? h("p", { class: "error" }, "A commission was reversed after this was requested: the partner's balance no longer covers it. Reject it.") : null,
    w.partner_status === "suspended" ? h("p", { class: "error" }, "This partner is suspended.") : null,
    h("dl", { class: "kv" },
      h("dt", {}, "Send to"), h("dd", {}, `+${w.phone} · ${NETWORKS[w.network] || w.network}`),
      h("dt", {}, "Partner"), h("dd", {}, h("a", { href: `#partners/${enc(w.partner_id)}` }, `${w.full_name || "—"} (${w.code || "—"})`)),
      h("dt", {}, "Requested"), h("dd", {}, fmtDate(w.requested_at)),
      h("dt", {}, "Our reference"), h("dd", {}, w.reference),
      h("dt", {}, "AzamPay reference"), h("dd", {}, w.provider_reference || "—"),
      h("dt", {}, "Message"), h("dd", {}, w.provider_message || w.admin_note || "—"),
      h("dt", {}, "Paid"), h("dd", {}, w.paid_at ? `${fmtDate(w.paid_at)}${w.paid_manually ? " (recorded by hand)" : ""}` : "—")),
    h("div", { class: "modal-actions" }, ...actions, h("button", { class: "btn", type: "button", onclick: closeModal }, "Close")));
}

// ── Settings ──────────────────────────────────────────────────────────────

async function renderSettings(root) {
  const body = h("div", {}, loading());
  root.append(body);
  let s, levels;
  try {
    const [rows, tiers] = await Promise.all([
      rest("business_settings?select=*"),
      rest("commission_tiers?select=*&order=min_people").catch(() => null),
    ]);
    s = rows && rows[0];
    levels = tiers && tiers.length ? tiers : [{ min_people: 1, rate_bp: s ? s.commission_bp : 2000 }];
  } catch (err) {
    body.replaceChildren(migrationMissing(err) ? planNotLive() : loadError(err, () => route()));
    return;
  }
  if (!s) { body.replaceChildren(planNotLive()); return; }

  const field = (label, value, hint, attrs) => {
    const input = h("input", { type: "number", inputmode: "decimal", value: String(value), ...attrs });
    return [input, h("label", {}, label, input, h("span", { class: "hint" }, hint))];
  };
  const [ded, dedL] = field("Taken off first (%)", num(s.commission_deduction_bp) / 100, "For taxes and payment charges. 0 = the full price counts.", { min: "0", max: "50", step: "0.5" });
  const [hold, holdL] = field("Refund window (days)", s.commission_hold_days, "Earnings wait this long before they can be withdrawn.", { min: "0", max: "90", step: "1" });
  const [minW, minL] = field("Smallest withdrawal (TZS)", s.min_withdrawal, "Set this to the smallest amount you can send out. Pesapal shows its own minimum on the Withdraw Funds page of your Pesapal dashboard.", { min: "1000", step: "1000" });
  const [fair, fairL] = field("Fair use: new numbers per day", s.fair_use_daily, "Most new people one unlimited package can open in 24 hours.", { min: "5", max: "1000", step: "1" });
  const signupsOpen = h("input", { type: "checkbox" });
  signupsOpen.checked = s.partner_signups_open !== false;
  const signupsLabel = h("div", { class: "form" },
    h("label", { class: "switch" }, signupsOpen, "Accept new partners"),
    h("span", { class: "hint" }, "Turn off to pause new people joining the partner programme. Existing partners keep earning, withdrawing and referring."));

  // ── Commission levels ──
  // Each row: from N paying people up, the partner earns R% of each purchase.
  const rows = levels.map((l) => ({ from: String(l.min_people), rate: String(num(l.rate_bp) / 100) }));
  rows[0].from = "1";
  const levelsBox = h("div", {});
  const example = h("div", { class: "card offer-preview" });
  const readLevels = () => rows.map((r) => ({ min_people: Number(r.from), rate_bp: Math.round(Number(r.rate) * 100) }));
  const drawExample = () => {
    const ls = readLevels();
    const d = Number(ded.value) * 100;
    const on = (amount, bp) => Math.floor((amount * (10000 - d)) / 10000 * bp / 10000);
    const amounts = [1000, 2500, 10000];
    example.replaceChildren(h("div", { class: "chart-title" }, "What a partner earns on one purchase"),
      h("table", { class: "mini" },
        h("thead", {}, h("tr", {}, h("th", {}, "Paying people"), ...amounts.map((a) => h("th", { class: "num" }, tzs(a))))),
        h("tbody", {}, ls.map((l, i) => h("tr", {},
          h("td", {}, i + 1 < ls.length ? `${count(l.min_people)}–${count(ls[i + 1].min_people - 1)}` : `${count(l.min_people)}+`,
            h("span", { class: "muted" }, ` · ${percentOf(l.rate_bp)}`)),
          ...amounts.map((a) => h("td", { class: "num" }, Number.isFinite(on(a, l.rate_bp)) ? tzs(on(a, l.rate_bp)) : "—")))))));
  };
  const drawLevels = () => {
    levelsBox.replaceChildren(
      h("div", { class: "levels" }, rows.map((r, i) => {
        const from = h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: r.from, disabled: i === 0 });
        const rate = h("input", { type: "number", min: "0", max: "50", step: "0.5", inputmode: "decimal", value: r.rate });
        from.addEventListener("input", () => { r.from = from.value; drawExample(); });
        rate.addEventListener("input", () => { r.rate = rate.value; drawExample(); });
        return h("div", { class: "level-row" },
          h("label", {}, "From person", from),
          h("label", {}, "Earns (%)", rate),
          i === 0 ? h("span", {}) : h("button", { class: "btn ghost small", type: "button", title: "Remove this level",
            onclick: () => { rows.splice(i, 1); drawLevels(); drawExample(); } }, "Remove"));
      })),
      h("button", { class: "btn ghost small", type: "button", onclick: () => {
        const last = rows[rows.length - 1];
        rows.push({ from: String(Number(last.from || 1) + 50), rate: last.rate });
        drawLevels(); drawExample();
      } }, "+ Add a level"));
  };
  ded.addEventListener("input", drawExample);
  drawLevels();
  drawExample();

  const error = h("p", { class: "error", hidden: true });
  const save = h("button", { class: "btn primary", type: "button" }, "Save settings");
  save.addEventListener("click", async () => {
    error.hidden = true;
    const ls = readLevels();
    const v = {
      commission_deduction_bp: Math.round(Number(ded.value) * 100),
      commission_hold_days: Number(hold.value),
      min_withdrawal: Number(minW.value),
      fair_use_daily: Number(fair.value),
      partner_signups_open: signupsOpen.checked,
    };
    const levelProblem = ls.map((l, i) =>
      (!Number.isInteger(l.min_people) || l.min_people < 1) ? `Level ${i + 1}: “From person” must be a whole number.`
        : (i > 0 && l.min_people <= ls[i - 1].min_people) ? `Level ${i + 1} must start above level ${i} (${count(ls[i - 1].min_people)}).`
          : (!(l.rate_bp >= 0 && l.rate_bp <= 5000)) ? `Level ${i + 1}: the rate must be between 0% and 50%.` : null).find(Boolean);
    const bad = levelProblem
      || (!(v.commission_deduction_bp >= 0 && v.commission_deduction_bp <= 5000) && "“Taken off first” must be between 0% and 50%.")
      || (!(Number.isInteger(v.commission_hold_days) && v.commission_hold_days >= 0 && v.commission_hold_days <= 90) && "The refund window must be 0 to 90 days.")
      || (!(Number.isInteger(v.min_withdrawal) && v.min_withdrawal >= 1000) && "The smallest withdrawal must be at least TZS 1,000.")
      || (!(Number.isInteger(v.fair_use_daily) && v.fair_use_daily >= 5 && v.fair_use_daily <= 1000) && "Fair use must be 5 to 1000.");
    if (bad) { error.textContent = bad; error.hidden = false; return; }
    save.disabled = true;
    save.replaceChildren(h("span", { class: "spinner" }), "Saving…");
    try {
      await rpc("admin_set_commission_tiers", { p_tiers: ls });
      const saved = await rest("business_settings?id=eq.true", { method: "PATCH", body: v, prefer: "return=representation" });
      if (!saved || !saved[0]) throw new ApiError("forbidden", 403, "Not allowed to change settings");
      toast("Settings saved. New purchases use them from now on.");
      route();
    } catch (err) {
      error.textContent = `Couldn't save. ${errorText(err)}`;
      error.hidden = false;
      save.disabled = false;
      save.replaceChildren("Save settings");
    }
  });

  body.replaceChildren(
    h("div", { class: "note" }, "Changes apply to purchases made from now on. Commissions already earned keep the rate they were earned at."),
    h("div", { class: "grid2" },
      h("div", { class: "card" }, h("h3", { class: "card-title" }, "Commission levels"),
        h("p", { class: "muted small" }, "A partner's level counts the people they brought who have paid at least once. Every new purchase earns the rate of the level they are on."),
        levelsBox,
        h("div", { style: { marginTop: "14px" } }, example)),
      h("div", {},
        h("div", { class: "card" }, h("h3", { class: "card-title" }, "Partner programme"),
          h("div", { class: "form" }, dedL, holdL, minL), signupsLabel),
        h("div", { class: "card", style: { marginTop: "14px" } }, h("h3", { class: "card-title" }, "Unlimited packages"), h("div", { class: "form" }, fairL)))),
    error,
    h("div", { class: "modal-actions" }, h("span", { class: "muted small" }, `Last changed ${fmtDate(s.updated_at)}`), save));
}

// ── Start ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("signin-email").value;
    const password = $("signin-password").value;
    const btn = $("signin-btn");
    const err = $("signin-error");
    if (!email.trim() || !password) {
      err.textContent = "Enter your email and password.";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    btn.disabled = true;
    btn.replaceChildren(h("span", { class: "spinner" }), "Signing in…");
    try {
      await signIn(email, password);
      $("signin-password").value = "";
      await enterApp();
    } catch (ex) {
      err.textContent = ex.status === 400 ? "Email or password is incorrect." : errorText(ex);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.replaceChildren("Sign in");
    }
  });

  $("signout-btn").addEventListener("click", () => {
    const s = store.get();
    if (s?.accessToken) {
      // Best effort: end the session on the server too.
      fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${s.accessToken}` },
      }).catch(() => {});
    }
    showSignIn();
  });

  $("refresh-btn").addEventListener("click", route);
  $("modal-close").addEventListener("click", closeModal);
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  window.addEventListener("hashchange", route);

  if (store.get()) enterApp().catch((err) => showSignIn(errorText(err)));
  else showSignIn();
});
