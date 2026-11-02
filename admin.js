// SmartTransit admin dashboard.
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
};
const packageName = (id) => PACKAGE_NAMES[id] || id || "—";

const VIEWS = {
  overview: { title: "Overview", render: renderOverview },
  payments: { title: "Payments", render: renderPayments },
  customers: { title: "Customers", render: renderCustomers },
  packages: { title: "Packages & prices", render: renderPackages },
  insights: { title: "Insights", render: renderInsights },
  posts: { title: "Posts", render: renderPosts },
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
  for (const c of children.flat()) {
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

function stat(label, value, tone) {
  return h("div", { class: `stat ${tone || ""}` },
    h("div", { class: "value" }, value),
    h("div", { class: "label" }, label));
}

function statusBadge(status, isMock) {
  const map = {
    completed: ["Paid", "ok"], pending: ["Waiting", "warn"],
    failed: ["Failed", "bad"], cancelled: ["Cancelled", "grey"],
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
  route();
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
  $("modal-body").replaceChildren(...content);
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
  const [summary, latest, insights] = await Promise.allSettled([
    rpc("admin_payment_summary"),
    rest(`payment_orders?select=${PAYMENT_SELECT}&order=created_at.desc&limit=8`),
    rpc("admin_insights"),
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
  const filters = [[null, "All"], ["completed", "Paid"], ["pending", "Waiting"], ["failed", "Failed"], ["cancelled", "Cancelled"]];
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
      p.order_tracking_id && p.method !== "appleIap" && p.status !== "completed" ? recheck : null,
      h("button", { class: "btn", type: "button", onclick: closeModal }, "Close")),
  );
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
  const [profile, phones, subs, payments] = await Promise.allSettled([
    rest(`profiles?id=eq.${q}&select=*`),
    rest(`user_phones?user_id=eq.${q}&select=phone,position,locked_until&order=position`),
    rest(`package_subscriptions?provider_id=eq.${q}&select=*&order=created_at.desc`),
    rest(`payment_orders?provider_id=eq.${q}&select=${PAYMENT_SELECT}&order=created_at.desc`),
  ]);
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
      h("thead", {}, h("tr", {}, h("th", {}, "Package"), h("th", {}, "Listings"), h("th", {}, "Started"), h("th", {}, "Ends"), h("th", {}, "Status"))),
      h("tbody", {}, subRows.map((s) => {
        const active = s.status === "active" && new Date(s.expires_at).getTime() > now;
        return h("tr", {},
          h("td", {}, packageName(s.package_id)),
          h("td", {}, count(s.listing_allowance)),
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
        h("dt", {}, "User ID"), h("dd", { class: "small" }, c.id))),
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
  grid.replaceChildren(...rows.map(packageEditor));
}

function packageEditor(pkg) {
  let saved = { ...pkg };
  const field = (label, value, attrs = {}) => {
    const input = h("input", { type: "number", inputmode: "numeric", value: String(value), ...attrs });
    return [input, h("label", {}, label, input)];
  };
  const [price, priceLabel] = field("Price (TZS)", pkg.amount, { min: "500", step: "500" });
  const [listings, listingsLabel] = field("Listings allowed", pkg.listing_allowance, { min: "1", max: "500" });
  const [days, daysLabel] = field("Duration (days)", pkg.validity_days, { min: "1", max: "730" });
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
    listing_allowance: Number(listings.value.trim()),
    validity_days: Number(days.value.trim()),
    active: active.checked,
  });
  const changed = () => {
    const v = values();
    return v.amount !== saved.amount || v.listing_allowance !== saved.listing_allowance ||
      v.validity_days !== saved.validity_days || v.active !== (saved.active !== false);
  };
  const refresh = () => { saveBtn.disabled = !changed(); updateSaleLabel(); };
  [price, listings, days].forEach((i) => i.addEventListener("input", refresh));
  active.addEventListener("change", refresh);

  saveBtn.addEventListener("click", async () => {
    const v = values();
    if (!Number.isInteger(v.amount) || v.amount < 500) { toast("Price must be a whole number of at least TZS 500.", true); return; }
    if (!Number.isInteger(v.listing_allowance) || v.listing_allowance < 1 || v.listing_allowance > 500) { toast("Listings must be between 1 and 500.", true); return; }
    if (!Number.isInteger(v.validity_days) || v.validity_days < 1 || v.validity_days > 730) { toast("Duration must be between 1 and 730 days.", true); return; }
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

  return h("div", { class: "card" },
    h("div", { class: "pkg-head" },
      h("h3", {}, packageName(pkg.id)),
      h("label", { class: "switch" }, onSale, active)),
    h("div", { class: "pkg-fields" }, priceLabel, listingsLabel, daysLabel),
    h("div", { class: "pkg-foot" }, updated, saveBtn));
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
