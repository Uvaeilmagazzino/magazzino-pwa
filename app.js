const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = window.APP_CONFIG;
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

let currentUser = null;
let currentProfile = null;
let articlesCache = [];
let ordersCache = [];
let pendingCsvRows = [];

const $ = (id) => document.getElementById(id);

const loginView = $("login-view");
const appView = $("app-view");
const loginForm = $("login-form");
const loginError = $("login-error");
const logoutBtn = $("logout-btn");
const menuToggle = $("menu-toggle");
const sidebar = document.querySelector(".sidebar");

const money = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
const numberFmt = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 3 });

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3000);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusLabel(status) {
  const labels = {
    open: "Aperta",
    in_progress: "In corso",
    completed: "Completata",
    cancelled: "Annullata"
  };
  return labels[status] || status;
}

async function loadProfile() {
  const { data, error } = await db
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", currentUser.id)
    .single();

  if (error) throw error;
  currentProfile = data;
}

function applyRoleUI() {
  const role = currentProfile?.role || "operator";
  $("role-label").textContent = role === "master" ? "Master" : "Operatore";
  $("user-name").textContent = currentProfile?.full_name?.trim() || "Utente";
  $("user-email").textContent = currentUser?.email || "";

  document.querySelectorAll(".master-only").forEach((el) => {
    el.classList.toggle("hidden", role !== "master");
  });
}

async function enterApp(user) {
  currentUser = user;
  await loadProfile();
  applyRoleUI();

  loginView.classList.add("hidden");
  appView.classList.remove("hidden");

  await Promise.all([loadArticles(), loadOrders()]);
  renderDashboard();
}

function leaveApp() {
  currentUser = null;
  currentProfile = null;
  articlesCache = [];
  ordersCache = [];
  pendingCsvRows = [];
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  loginForm.reset();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.classList.add("hidden");

  const button = $("login-btn");
  button.disabled = true;
  button.textContent = "Accesso...";

  const email = $("email").value.trim();
  const password = $("password").value;

  const { data, error } = await db.auth.signInWithPassword({ email, password });

  button.disabled = false;
  button.textContent = "Accedi";

  if (error) {
    loginError.textContent = "Email o password non corretti.";
    loginError.classList.remove("hidden");
    return;
  }

  try {
    await enterApp(data.user);
  } catch (err) {
    console.error(err);
    loginError.textContent = "Accesso riuscito, ma non riesco a caricare il profilo.";
    loginError.classList.remove("hidden");
  }
});

logoutBtn.addEventListener("click", async () => {
  await db.auth.signOut();
  leaveApp();
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.section;

    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");

    document.querySelectorAll(".section").forEach((section) => section.classList.remove("active"));
    $(`section-${target}`).classList.add("active");

    const titles = {
      dashboard: "Dashboard",
      articles: "Articoli",
      orders: "Lavorazioni"
    };
    $("page-title").textContent = titles[target] || "Magazzino";

    sidebar.classList.remove("open");
  });
});

menuToggle?.addEventListener("click", () => sidebar.classList.toggle("open"));

async function loadArticles() {
  const { data, error } = await db
    .from("articles")
    .select("id, code, description, quantity, unit_price, unit, created_at")
    .order("description", { ascending: true });

  if (error) {
    console.error(error);
    showToast("Errore nel caricamento degli articoli");
    return;
  }

  articlesCache = data || [];
  renderArticles();
}

function renderArticles() {
  const query = $("article-search").value.trim().toLowerCase();
  const rows = articlesCache.filter((a) => {
    return !query ||
      a.code.toLowerCase().includes(query) ||
      a.description.toLowerCase().includes(query);
  });

  $("articles-body").innerHTML = rows.map((a) => `
    <tr>
      <td><strong>${escapeHtml(a.code)}</strong></td>
      <td>${escapeHtml(a.description)}</td>
      <td>${numberFmt.format(Number(a.quantity || 0))}</td>
      <td>${escapeHtml(a.unit)}</td>
      <td>${money.format(Number(a.unit_price || 0))}</td>
    </tr>
  `).join("");

  $("articles-empty").classList.toggle("hidden", rows.length > 0);
}

$("article-search").addEventListener("input", renderArticles);

$("new-article-btn").addEventListener("click", () => {
  $("article-form").reset();
  $("article-quantity").value = "0";
  $("article-unit").value = "pz";
  $("article-price").value = "0";
  $("article-dialog").showModal();
});

$("article-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    code: $("article-code").value.trim(),
    description: $("article-description").value.trim(),
    quantity: Number($("article-quantity").value),
    unit: $("article-unit").value.trim() || "pz",
    unit_price: Number($("article-price").value)
  };

  const { error } = await db.from("articles").insert(payload);

  if (error) {
    console.error(error);
    showToast(error.code === "23505" ? "Codice articolo già esistente" : "Errore nel salvataggio");
    return;
  }

  $("article-dialog").close();
  showToast("Articolo creato");
  await loadArticles();
  renderDashboard();
});

/* =========================
   IMPORTAZIONE CSV
   ========================= */

$("import-csv-btn").addEventListener("click", () => {
  $("csv-file-input").value = "";
  $("csv-file-input").click();
});

$("csv-file-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    prepareCsvPreview(text, file.name);
  } catch (err) {
    console.error(err);
    showToast("Non riesco a leggere il file CSV");
  }
});

function detectDelimiter(text) {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/)[0] || "";
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;
  return semicolons > commas ? ";" : ",";
}

function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";

      if (row.some((value) => String(value).trim() !== "")) {
        rows.push(row);
      }
      row = [];
    } else {
      field += ch;
    }
  }

  row.push(field);
  if (row.some((value) => String(value).trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function parseNumber(value) {
  let raw = String(value ?? "").trim().replace(/\s/g, "");

  if (!raw) return NaN;

  // Gestisce sia 1234.56 che 1.234,56 / 1234,56
  if (raw.includes(",") && raw.includes(".")) {
    if (raw.lastIndexOf(",") > raw.lastIndexOf(".")) {
      raw = raw.replace(/\./g, "").replace(",", ".");
    } else {
      raw = raw.replace(/,/g, "");
    }
  } else if (raw.includes(",")) {
    raw = raw.replace(",", ".");
  }

  return Number(raw);
}

function prepareCsvPreview(text, filename) {
  const rawRows = parseCsv(text);

  if (rawRows.length < 2) {
    showToast("Il CSV non contiene dati");
    return;
  }

  const headers = rawRows[0].map(normalizeHeader);
  const required = ["code", "description", "quantity", "unit_price", "unit"];
  const missing = required.filter((name) => !headers.includes(name));

  if (missing.length) {
    showToast(`Colonne mancanti: ${missing.join(", ")}`);
    return;
  }

  const index = Object.fromEntries(headers.map((name, i) => [name, i]));
  const existingCodes = new Set(articlesCache.map((a) => a.code.trim().toLowerCase()));
  const errors = [];
  const seenCodes = new Set();
  const parsed = [];

  rawRows.slice(1).forEach((cols, rowIndex) => {
    const line = rowIndex + 2;
    const code = String(cols[index.code] ?? "").trim();
    const description = String(cols[index.description] ?? "").trim();
    const quantity = parseNumber(cols[index.quantity]);
    const unitPrice = parseNumber(cols[index.unit_price]);
    const unit = String(cols[index.unit] ?? "").trim() || "pz";
    const key = code.toLowerCase();
    const rowErrors = [];

    if (!code) rowErrors.push("codice mancante");
    if (!description) rowErrors.push("descrizione mancante");
    if (!Number.isFinite(quantity) || quantity < 0) rowErrors.push("quantità non valida");
    if (!Number.isFinite(unitPrice) || unitPrice < 0) rowErrors.push("prezzo non valido");
    if (key && seenCodes.has(key)) rowErrors.push("codice duplicato nel CSV");

    if (key) seenCodes.add(key);

    const mode = existingCodes.has(key) ? "update" : "new";

    parsed.push({
      line,
      code,
      description,
      quantity,
      unit_price: unitPrice,
      unit,
      mode,
      errors: rowErrors
    });

    if (rowErrors.length) {
      errors.push(`Riga ${line} (${code || "senza codice"}): ${rowErrors.join(", ")}`);
    }
  });

  pendingCsvRows = parsed.filter((row) => row.errors.length === 0);

  const newCount = pendingCsvRows.filter((row) => row.mode === "new").length;
  const updateCount = pendingCsvRows.filter((row) => row.mode === "update").length;

  $("csv-filename").textContent = filename;
  $("csv-valid-count").textContent = pendingCsvRows.length;
  $("csv-new-count").textContent = newCount;
  $("csv-update-count").textContent = updateCount;
  $("csv-error-count").textContent = errors.length;

  const errorBox = $("csv-errors-box");
  if (errors.length) {
    errorBox.innerHTML = `
      <strong>Righe da correggere:</strong>
      <ul>${errors.slice(0, 20).map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
      ${errors.length > 20 ? `<div>...e altre ${errors.length - 20} righe.</div>` : ""}
    `;
    errorBox.classList.remove("hidden");
  } else {
    errorBox.innerHTML = "";
    errorBox.classList.add("hidden");
  }

  $("csv-preview-body").innerHTML = parsed.slice(0, 100).map((row) => {
    const hasError = row.errors.length > 0;
    const badgeClass = hasError ? "csv-error" : row.mode === "new" ? "csv-new" : "csv-update";
    const badgeText = hasError ? "Errore" : row.mode === "new" ? "Nuovo" : "Aggiorna";

    return `
      <tr>
        <td><strong>${escapeHtml(row.code)}</strong></td>
        <td>${escapeHtml(row.description)}</td>
        <td>${Number.isFinite(row.quantity) ? numberFmt.format(row.quantity) : "—"}</td>
        <td>${Number.isFinite(row.unit_price) ? money.format(row.unit_price) : "—"}</td>
        <td>${escapeHtml(row.unit)}</td>
        <td><span class="badge ${badgeClass}">${badgeText}</span></td>
      </tr>
    `;
  }).join("");

  const importButton = $("confirm-csv-import-btn");
  importButton.disabled = pendingCsvRows.length === 0 || errors.length > 0;
  importButton.textContent = errors.length > 0 ? "Correggi il CSV" : `Importa ${pendingCsvRows.length} righe`;

  $("csv-dialog").showModal();
}

$("confirm-csv-import-btn").addEventListener("click", async () => {
  if (!pendingCsvRows.length) return;

  const button = $("confirm-csv-import-btn");
  button.disabled = true;
  button.textContent = "Importazione...";

  const payload = pendingCsvRows.map((row) => ({
    code: row.code,
    description: row.description,
    quantity: row.quantity,
    unit_price: row.unit_price,
    unit: row.unit,
    updated_at: new Date().toISOString()
  }));

  // Invio a blocchi per gestire anche CSV più grandi
  const batchSize = 250;

  try {
    for (let i = 0; i < payload.length; i += batchSize) {
      const batch = payload.slice(i, i + batchSize);
      const { error } = await db
        .from("articles")
        .upsert(batch, { onConflict: "code" });

      if (error) throw error;
    }

    $("csv-dialog").close();
    pendingCsvRows = [];
    showToast(`Importazione completata: ${payload.length} articoli`);
    await loadArticles();
    renderDashboard();
  } catch (err) {
    console.error(err);
    showToast(`Importazione non riuscita: ${err.message || "errore sconosciuto"}`);
  } finally {
    button.disabled = false;
    button.textContent = "Importa";
  }
});

async function loadOrders() {
  const { data, error } = await db
    .from("work_orders")
    .select("id, code, description, status, created_at, completed_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    showToast("Errore nel caricamento delle lavorazioni");
    return;
  }

  ordersCache = data || [];
  renderOrders();
}

function renderOrders() {
  const filter = $("order-filter").value;
  const rows = ordersCache.filter((o) => filter === "all" || o.status === filter);

  $("orders-list").innerHTML = rows.map((o) => `
    <article class="order-card">
      <div>
        <h4>${escapeHtml(o.description)}</h4>
        <div class="muted">${escapeHtml(o.code)}</div>
        <div class="order-meta">
          <span class="badge ${escapeHtml(o.status)}">${statusLabel(o.status)}</span>
          <span class="badge">${new Date(o.created_at).toLocaleDateString("it-IT")}</span>
        </div>
      </div>
    </article>
  `).join("");

  $("orders-empty").classList.toggle("hidden", rows.length > 0);
}

$("order-filter").addEventListener("change", renderOrders);

$("new-order-btn").addEventListener("click", () => {
  $("order-form").reset();
  $("order-dialog").showModal();
});

$("order-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    code: $("order-code").value.trim(),
    description: $("order-description").value.trim(),
    status: "open"
  };

  const { error } = await db.from("work_orders").insert(payload);

  if (error) {
    console.error(error);
    showToast(error.code === "23505" ? "Codice lavorazione già esistente" : "Errore nella creazione");
    return;
  }

  $("order-dialog").close();
  showToast("Lavorazione creata");
  await loadOrders();
  renderDashboard();
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = $(button.dataset.closeDialog);
    dialog?.close();
  });
});

function renderDashboard() {
  $("stat-articles").textContent = numberFmt.format(articlesCache.length);
  $("stat-open-orders").textContent = numberFmt.format(
    ordersCache.filter((o) => ["open", "in_progress"].includes(o.status)).length
  );
  $("stat-completed-orders").textContent = numberFmt.format(
    ordersCache.filter((o) => o.status === "completed").length
  );

  const stockValue = articlesCache.reduce(
    (sum, a) => sum + Number(a.quantity || 0) * Number(a.unit_price || 0),
    0
  );
  $("stat-stock-value").textContent = money.format(stockValue);

  const recent = ordersCache.slice(0, 5);
  $("recent-orders").innerHTML = recent.length
    ? recent.map((o) => `
      <div class="order-card">
        <div>
          <strong>${escapeHtml(o.description)}</strong>
          <div class="muted">${escapeHtml(o.code)}</div>
        </div>
        <span class="badge ${escapeHtml(o.status)}">${statusLabel(o.status)}</span>
      </div>
    `).join("")
    : `<div class="empty">Nessuna lavorazione presente.</div>`;
}

async function boot() {
  const { data: { session } } = await db.auth.getSession();

  if (session?.user) {
    try {
      await enterApp(session.user);
    } catch (err) {
      console.error(err);
      await db.auth.signOut();
      leaveApp();
    }
  } else {
    leaveApp();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(console.error);
  }
}

boot();
