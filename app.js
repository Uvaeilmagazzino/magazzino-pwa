const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = window.APP_CONFIG;
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const APP_VERSION = "v0.4.1";

let currentUser = null;
let currentProfile = null;
let articlesCache = [];
let ordersCache = [];
let usersCache = [];
let rolesCache = [];
let pendingCsvRows = [];
let activeWorkOrder = null;
let activeWorkItems = [];

const $ = (id) => document.getElementById(id);

const loadingView = $("loading-view");
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
    .select("id, full_name, email, role")
    .eq("id", currentUser.id)
    .single();

  if (error) throw error;
  currentProfile = data;
}

function roleLabel(roleId) {
  const role = rolesCache.find((item) => item.id === roleId);
  if (role?.label) return role.label;
  if (roleId === "master") return "Master";
  if (roleId === "operator") return "Operatore";
  return roleId || "Operatore";
}

function showResolvedView(view) {
  loadingView.classList.add("hidden");
  loginView.classList.toggle("hidden", view !== "login");
  appView.classList.toggle("hidden", view !== "app");
}

function applyRoleUI() {
  const role = currentProfile?.role || "operator";
  const isMaster = role === "master";

  $("role-label").textContent = roleLabel(role);
  $("release-label").textContent = APP_VERSION;
  $("user-name").textContent = currentProfile?.full_name?.trim() || "Utente";
  $("user-email").textContent = currentProfile?.email || currentUser?.email || "";

  document.body.classList.toggle("operator-mode", !isMaster);
  document.querySelectorAll(".master-only").forEach((el) => {
    el.classList.toggle("hidden", !isMaster);
  });

  $("operator-dashboard-banner")?.classList.toggle("hidden", isMaster);
  if ($("orders-help")) {
    $("orders-help").textContent = isMaster
      ? "Crea, controlla, completa o elimina le lavorazioni."
      : "Apri una lavorazione, registra i materiali prelevati e completala.";
  }
  if ($("recent-title")) {
    $("recent-title").textContent = isMaster ? "Attività recenti" : "Lavorazioni da eseguire";
    $("recent-subtitle").textContent = isMaster
      ? "Ultime lavorazioni create o aggiornate."
      : "Apri una lavorazione per iniziare a registrare i materiali.";
  }
}

async function enterApp(user) {
  currentUser = user;
  await loadProfile();
  await loadRoles();
  applyRoleUI();

  const loaders = [loadArticles(), loadOrders()];
  if (currentProfile?.role === "master") loaders.push(loadUsers());
  await Promise.all(loaders);

  renderDashboard();
  showResolvedView("app");
}

function leaveApp() {
  currentUser = null;
  currentProfile = null;
  articlesCache = [];
  ordersCache = [];
  usersCache = [];
  rolesCache = [];
  pendingCsvRows = [];
  activeWorkOrder = null;
  activeWorkItems = [];
  showResolvedView("login");
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
    await db.auth.signOut();
    showResolvedView("login");
    loginError.textContent = "Accesso riuscito, ma non riesco a caricare il profilo.";
    loginError.classList.remove("hidden");
  }
});

logoutBtn.addEventListener("click", async () => {
  await db.auth.signOut();
  leaveApp();
});

function openSection(target) {
  const targetButton = document.querySelector(`.nav-item[data-section="${target}"]`);
  const targetSection = $(`section-${target}`);
  if (!targetButton || !targetSection || targetButton.classList.contains("hidden")) {
    target = "dashboard";
  }

  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.section === target);
  });

  document.querySelectorAll(".section").forEach((section) => {
    section.classList.toggle("active", section.id === `section-${target}`);
  });

  const titles = {
    dashboard: "Dashboard",
    articles: "Articoli",
    orders: "Lavorazioni",
    users: "Utenti"
  };
  $("page-title").textContent = titles[target] || "Magazzino";
  sidebar.classList.remove("open");
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => openSection(button.dataset.section));
});

function activateDashboardStat(target) {
  if (target === "articles") {
    openSection("articles");
    $("article-search")?.focus();
    return;
  }

  if (target === "open-orders") {
    $("order-filter").value = "open";
    renderOrders();
    openSection("orders");
    return;
  }

  if (target === "completed-orders") {
    $("order-filter").value = "completed";
    renderOrders();
    openSection("orders");
  }
}

document.querySelectorAll(".clickable-stat").forEach((card) => {
  card.addEventListener("click", () => activateDashboardStat(card.dataset.statTarget));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateDashboardStat(card.dataset.statTarget);
    }
  });
});

menuToggle?.addEventListener("click", () => sidebar.classList.toggle("open"));

async function loadRoles() {
  const { data, error } = await db
    .from("roles")
    .select("id, label, sort_order, active")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error(error);
    rolesCache = [
      { id: "master", label: "Master", sort_order: 10, active: true },
      { id: "operator", label: "Operatore", sort_order: 100, active: true }
    ];
    return;
  }

  rolesCache = data || [];
}

async function loadUsers() {
  if (currentProfile?.role !== "master") {
    usersCache = [];
    renderUsers();
    return;
  }

  const { data, error } = await db
    .from("profiles")
    .select("id, full_name, email, role")
    .order("email", { ascending: true });

  if (error) {
    console.error(error);
    showToast("Errore nel caricamento degli utenti");
    return;
  }

  usersCache = data || [];
  renderUsers();
}

function renderUsers() {
  const body = $("users-body");
  if (!body) return;

  const roleOptions = (selectedRole) => rolesCache.map((role) => `
    <option value="${escapeHtml(role.id)}" ${role.id === selectedRole ? "selected" : ""}>
      ${escapeHtml(role.label)}
    </option>
  `).join("");

  body.innerHTML = usersCache.map((profile) => {
    const isCurrent = profile.id === currentUser?.id;
    const displayName = profile.full_name?.trim() || "Utente";

    return `
      <tr>
        <td>
          <div class="user-primary">
            <span>${escapeHtml(displayName)}</span>
            ${isCurrent ? '<span class="you-badge">Tu</span>' : ""}
          </div>
        </td>
        <td>${escapeHtml(profile.email || "—")}</td>
        <td>
          <select class="role-select" data-user-id="${escapeHtml(profile.id)}" aria-label="Ruolo di ${escapeHtml(profile.email || displayName)}">
            ${roleOptions(profile.role)}
          </select>
        </td>
        <td>
          <button class="btn ghost save-role-btn" type="button" data-user-id="${escapeHtml(profile.id)}">
            Salva ruolo
          </button>
        </td>
      </tr>
    `;
  }).join("");

  $("users-empty").classList.toggle("hidden", usersCache.length > 0);
}

$("refresh-users-btn")?.addEventListener("click", async () => {
  await Promise.all([loadRoles(), loadUsers()]);
  applyRoleUI();
  renderUsers();
  showToast("Elenco utenti aggiornato");
});

$("users-body")?.addEventListener("click", async (event) => {
  const button = event.target.closest(".save-role-btn");
  if (!button) return;

  const userId = button.dataset.userId;
  const select = document.querySelector(`.role-select[data-user-id="${userId}"]`);
  const newRole = select?.value;
  const profile = usersCache.find((item) => item.id === userId);

  if (!newRole || !profile) return;

  if (newRole === profile.role) {
    showToast("Il ruolo è già impostato così");
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Salvataggio...";

  try {
    const { error } = await db.rpc("set_user_role", {
      target_user_id: userId,
      new_role: newRole
    });
    if (error) throw error;

    showToast(`Ruolo aggiornato: ${roleLabel(newRole)}`);

    if (userId === currentUser?.id) {
      await loadProfile();
      await loadRoles();
      applyRoleUI();

      if (currentProfile?.role !== "master") {
        usersCache = [];
        openSection("dashboard");
        return;
      }
    }

    await loadUsers();
  } catch (err) {
    console.error(err);
    const message = err?.message || "Errore nella modifica del ruolo";
    showToast(message);
    await loadUsers();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

async function loadArticles() {
  const { data, error } = await db.rpc("get_articles_for_app");

  if (error) {
    console.error(error);
    showToast("Errore nel caricamento degli articoli");
    return;
  }

  articlesCache = (data || []).sort((a, b) =>
    String(a.description || "").localeCompare(String(b.description || ""), "it")
  );
  renderArticles();
}

function renderArticles() {
  const query = $("article-search").value.trim().toLowerCase();
  const isMaster = currentProfile?.role === "master";
  const rows = articlesCache.filter((a) => {
    return !query ||
      String(a.code || "").toLowerCase().includes(query) ||
      String(a.description || "").toLowerCase().includes(query);
  });

  $("articles-body").innerHTML = rows.map((a) => `
    <tr>
      <td><strong>${escapeHtml(a.code)}</strong></td>
      <td>${escapeHtml(a.description)}</td>
      <td>${numberFmt.format(Number(a.quantity || 0))}</td>
      ${isMaster ? `<td>${escapeHtml(a.unit)}</td>` : ""}
      ${isMaster ? `<td>${money.format(Number(a.unit_price || 0))}</td>` : ""}
      ${isMaster ? `
        <td>
          <div class="row-actions">
            <button class="btn ghost small edit-article-btn" type="button" data-id="${a.id}">Modifica</button>
            <button class="btn danger small delete-article-btn" type="button" data-id="${a.id}">Elimina</button>
          </div>
        </td>` : ""}
    </tr>
  `).join("");

  $("articles-empty").classList.toggle("hidden", rows.length > 0);
}

$("article-search").addEventListener("input", renderArticles);

$("new-article-btn").addEventListener("click", () => {
  $("article-form").reset();
  $("article-id").value = "";
  $("article-dialog-title").textContent = "Nuovo articolo";
  $("article-code").disabled = false;
  $("article-quantity").value = "0";
  $("article-unit").value = "pz";
  $("article-price").value = "0";
  $("article-dialog").showModal();
});

$("articles-body").addEventListener("click", async (event) => {
  const editButton = event.target.closest(".edit-article-btn");
  const deleteButton = event.target.closest(".delete-article-btn");

  if (editButton) {
    const article = articlesCache.find((a) => String(a.id) === String(editButton.dataset.id));
    if (!article) return;

    $("article-form").reset();
    $("article-id").value = article.id;
    $("article-dialog-title").textContent = "Modifica articolo";
    $("article-code").value = article.code;
    $("article-code").disabled = false;
    $("article-description").value = article.description;
    $("article-quantity").value = Number(article.quantity || 0);
    $("article-unit").value = article.unit || "pz";
    $("article-price").value = Number(article.unit_price || 0);
    $("article-dialog").showModal();
    return;
  }

  if (deleteButton) {
    const article = articlesCache.find((a) => String(a.id) === String(deleteButton.dataset.id));
    if (!article) return;

    const ok = confirm(`Eliminare definitivamente l'articolo "${article.code} - ${article.description}"?`);
    if (!ok) return;

    const { error } = await db.rpc("master_delete_article", { p_article_id: article.id });
    if (error) {
      console.error(error);
      showToast(error.message || "Impossibile eliminare l'articolo");
      return;
    }

    showToast("Articolo eliminato");
    await loadArticles();
    renderDashboard();
  }
});

$("article-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const articleId = $("article-id").value || null;
  const args = {
    p_code: $("article-code").value.trim(),
    p_description: $("article-description").value.trim(),
    p_quantity: Number($("article-quantity").value),
    p_unit_price: Number($("article-price").value),
    p_unit: $("article-unit").value.trim() || "pz"
  };

  const rpcName = articleId ? "master_update_article" : "master_create_article";
  if (articleId) args.p_article_id = Number(articleId);

  const { error } = await db.rpc(rpcName, args);

  if (error) {
    console.error(error);
    showToast(error.message || "Errore nel salvataggio");
    return;
  }

  $("article-dialog").close();
  showToast(articleId ? "Articolo aggiornato" : "Articolo creato");
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
      const { error } = await db.rpc("master_import_articles", {
        p_rows: batch
      });

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
  const isMaster = currentProfile?.role === "master";
  const rows = ordersCache.filter((o) => {
    if (filter === "all") return true;
    if (filter === "open") return ["open", "in_progress"].includes(o.status);
    return o.status === filter;
  });

  $("orders-list").innerHTML = rows.map((o) => `
    <article class="order-card">
      <div class="order-card-main">
        <h4>${escapeHtml(o.description)}</h4>
        <div class="muted">${escapeHtml(o.code)}</div>
        <div class="order-meta">
          <span class="badge ${escapeHtml(o.status)}">${statusLabel(o.status)}</span>
          <span class="badge">${new Date(o.created_at).toLocaleDateString("it-IT")}</span>
        </div>
      </div>
      <div class="order-card-actions">
        <button class="btn primary open-work-btn" type="button" data-id="${o.id}">
          ${o.status === "completed" ? "Vedi distinta" : "Apri lavorazione"}
        </button>
        ${isMaster ? `<button class="btn danger delete-order-btn" type="button" data-id="${o.id}">Elimina</button>` : ""}
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

  const { error } = await db.rpc("master_create_work_order", {
    p_code: $("order-code").value.trim(),
    p_description: $("order-description").value.trim()
  });

  if (error) {
    console.error(error);
    showToast(error.message || "Errore nella creazione");
    return;
  }

  $("order-dialog").close();
  showToast("Lavorazione creata");
  await loadOrders();
  renderDashboard();
});

$("orders-list").addEventListener("click", async (event) => {
  const openButton = event.target.closest(".open-work-btn");
  const deleteButton = event.target.closest(".delete-order-btn");

  if (openButton) {
    await openWorkOrder(Number(openButton.dataset.id));
    return;
  }

  if (deleteButton) {
    await deleteWorkOrder(Number(deleteButton.dataset.id));
  }
});

async function openWorkOrder(orderId) {
  activeWorkOrder = ordersCache.find((o) => Number(o.id) === Number(orderId));
  if (!activeWorkOrder) return;

  $("work-title").textContent = activeWorkOrder.description;
  $("work-code").textContent = activeWorkOrder.code;
  $("work-status").textContent = statusLabel(activeWorkOrder.status);
  $("work-status").className = `badge ${activeWorkOrder.status}`;

  $("work-article-search").value = "";
  $("work-item-quantity").value = "1";
  populateWorkArticleSelect();

  await loadWorkItems();

  const isActive = ["open", "in_progress"].includes(activeWorkOrder.status);
  $("work-active-area").classList.toggle("hidden", !isActive);
  $("complete-work-btn").classList.toggle("hidden", !isActive);
  $("work-actions-head").classList.toggle("hidden", !isActive);
  $("work-items-help").textContent = isActive
    ? "Le giacenze verranno scaricate solo quando completi la lavorazione."
    : "Distinta definitiva dei materiali utilizzati.";

  $("work-dialog").showModal();
}

async function loadWorkItems() {
  if (!activeWorkOrder) return;

  const { data, error } = await db.rpc("get_work_order_items_for_app", {
    p_work_order_id: activeWorkOrder.id
  });

  if (error) {
    console.error(error);
    showToast("Errore nel caricamento dei materiali");
    activeWorkItems = [];
  } else {
    activeWorkItems = data || [];
  }

  renderWorkItems();
}

function renderWorkItems() {
  const isMaster = currentProfile?.role === "master";
  const isActive = activeWorkOrder && ["open", "in_progress"].includes(activeWorkOrder.status);

  $("work-items-body").innerHTML = activeWorkItems.map((item) => {
    const total = Number(item.quantity || 0) * Number(item.unit_price || 0);
    return `
      <tr>
        <td><strong>${escapeHtml(item.code)}</strong></td>
        <td>${escapeHtml(item.description)}</td>
        <td>${numberFmt.format(Number(item.quantity || 0))}</td>
        <td>${escapeHtml(item.unit)}</td>
        ${isMaster ? `<td>${money.format(Number(item.unit_price || 0))}</td>` : ""}
        ${isMaster ? `<td>${money.format(total)}</td>` : ""}
        ${isActive ? `
          <td>
            <div class="row-actions">
              <button class="btn ghost small edit-work-item-btn" type="button" data-article-id="${item.article_id}" data-quantity="${item.quantity}">Modifica</button>
              <button class="btn danger small remove-work-item-btn" type="button" data-article-id="${item.article_id}">Rimuovi</button>
            </div>
          </td>` : ""}
      </tr>
    `;
  }).join("");

  $("work-items-empty").classList.toggle("hidden", activeWorkItems.length > 0);

  const total = activeWorkItems.reduce(
    (sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_price || 0),
    0
  );
  $("work-total").textContent = money.format(total);
}

function populateWorkArticleSelect() {
  const select = $("work-article-select");
  const query = $("work-article-search").value.trim().toLowerCase();

  const filtered = articlesCache.filter((article) => {
    if (Number(article.quantity || 0) <= 0) return false;
    return !query ||
      String(article.code || "").toLowerCase().includes(query) ||
      String(article.description || "").toLowerCase().includes(query);
  });

  select.innerHTML = filtered.length
    ? filtered.map((article) => `
      <option value="${article.id}">
        ${escapeHtml(article.code)} — ${escapeHtml(article.description)}
      </option>
    `).join("")
    : `<option value="">Nessun articolo disponibile</option>`;

  updateSelectedStockInfo();
}

function updateSelectedStockInfo() {
  const article = articlesCache.find((a) => String(a.id) === String($("work-article-select").value));
  const box = $("selected-stock-info");
  if (!article) {
    box.textContent = "";
    return;
  }

  const already = activeWorkItems.find((item) => Number(item.article_id) === Number(article.id));
  const suffix = already ? ` • già inseriti: ${numberFmt.format(Number(already.quantity || 0))} ${article.unit}` : "";
  box.textContent = `Disponibili: ${numberFmt.format(Number(article.quantity || 0))} ${article.unit}${suffix}`;
  box.classList.remove("warning");
}

$("work-article-search").addEventListener("input", populateWorkArticleSelect);
$("work-article-select").addEventListener("change", updateSelectedStockInfo);

$("add-work-item-btn").addEventListener("click", async () => {
  if (!activeWorkOrder) return;

  const articleId = Number($("work-article-select").value);
  const quantity = Number($("work-item-quantity").value);
  const article = articlesCache.find((a) => Number(a.id) === articleId);

  if (!articleId || !Number.isFinite(quantity) || quantity <= 0) {
    showToast("Seleziona un articolo e una quantità valida");
    return;
  }

  if (quantity > Number(article?.quantity || 0)) {
    showToast("Quantità superiore alla giacenza disponibile");
    return;
  }

  const { error } = await db.rpc("save_work_order_item", {
    p_work_order_id: activeWorkOrder.id,
    p_article_id: articleId,
    p_quantity: quantity
  });

  if (error) {
    console.error(error);
    showToast(error.message || "Errore nell'aggiunta del materiale");
    return;
  }

  showToast("Materiale registrato");
  await loadOrders();
  activeWorkOrder = ordersCache.find((o) => Number(o.id) === Number(activeWorkOrder.id));
  $("work-status").textContent = statusLabel(activeWorkOrder.status);
  $("work-status").className = `badge ${activeWorkOrder.status}`;
  await loadWorkItems();
  populateWorkArticleSelect();
  renderDashboard();
});

$("work-items-body").addEventListener("click", async (event) => {
  const editButton = event.target.closest(".edit-work-item-btn");
  const removeButton = event.target.closest(".remove-work-item-btn");

  if (editButton) {
    $("work-article-select").value = editButton.dataset.articleId;
    if ($("work-article-select").value !== editButton.dataset.articleId) {
      $("work-article-search").value = "";
      populateWorkArticleSelect();
      $("work-article-select").value = editButton.dataset.articleId;
    }
    $("work-item-quantity").value = editButton.dataset.quantity;
    updateSelectedStockInfo();
    $("work-item-quantity").focus();
    return;
  }

  if (removeButton) {
    const ok = confirm("Rimuovere questo materiale dalla lavorazione?");
    if (!ok) return;

    const { error } = await db.rpc("remove_work_order_item", {
      p_work_order_id: activeWorkOrder.id,
      p_article_id: Number(removeButton.dataset.articleId)
    });

    if (error) {
      console.error(error);
      showToast(error.message || "Errore nella rimozione");
      return;
    }

    showToast("Materiale rimosso");
    await loadWorkItems();
    await loadOrders();
    activeWorkOrder = ordersCache.find((o) => Number(o.id) === Number(activeWorkOrder.id));
    renderDashboard();
  }
});

$("complete-work-btn").addEventListener("click", async () => {
  if (!activeWorkOrder) return;
  if (!activeWorkItems.length) {
    showToast("Aggiungi almeno un materiale prima di completare");
    return;
  }

  const ok = confirm(
    "Completare la lavorazione? Le quantità verranno scaricate definitivamente dal magazzino."
  );
  if (!ok) return;

  const button = $("complete-work-btn");
  button.disabled = true;
  button.textContent = "Completamento...";

  const { error } = await db.rpc("complete_work_order", {
    p_work_order_id: activeWorkOrder.id
  });

  button.disabled = false;
  button.textContent = "Completa lavorazione";

  if (error) {
    console.error(error);
    showToast(error.message || "Impossibile completare la lavorazione");
    return;
  }

  showToast("Lavorazione completata");
  await Promise.all([loadOrders(), loadArticles()]);
  activeWorkOrder = ordersCache.find((o) => Number(o.id) === Number(activeWorkOrder.id));
  await loadWorkItems();

  $("work-status").textContent = statusLabel(activeWorkOrder.status);
  $("work-status").className = `badge ${activeWorkOrder.status}`;
  $("work-active-area").classList.add("hidden");
  $("complete-work-btn").classList.add("hidden");
  $("work-actions-head").classList.add("hidden");
  $("work-items-help").textContent = "Distinta definitiva dei materiali utilizzati.";
  renderDashboard();
});

async function deleteWorkOrder(orderId) {
  const order = ordersCache.find((o) => Number(o.id) === Number(orderId));
  if (!order) return;

  const extra = order.status === "completed"
    ? "\\n\\nLa lavorazione è completata: le giacenze scaricate verranno ripristinate."
    : "";
  const ok = confirm(`Eliminare definitivamente "${order.code} - ${order.description}"?${extra}`);
  if (!ok) return;

  const { error } = await db.rpc("master_delete_work_order", {
    p_work_order_id: order.id
  });

  if (error) {
    console.error(error);
    showToast(error.message || "Impossibile eliminare la lavorazione");
    return;
  }

  if ($("work-dialog").open) $("work-dialog").close();
  activeWorkOrder = null;
  activeWorkItems = [];
  showToast("Lavorazione eliminata");
  await Promise.all([loadOrders(), loadArticles()]);
  renderDashboard();
}

$("delete-work-btn").addEventListener("click", async () => {
  if (activeWorkOrder) await deleteWorkOrder(activeWorkOrder.id);
});

$("go-open-orders-btn")?.addEventListener("click", () => {
  $("order-filter").value = "open";
  openSection("orders");
  renderOrders();
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = $(button.dataset.closeDialog);
    dialog?.close();
  });
});

function renderDashboard() {
  const isMaster = currentProfile?.role === "master";

  $("stat-articles").textContent = numberFmt.format(articlesCache.length);
  $("stat-open-orders").textContent = numberFmt.format(
    ordersCache.filter((o) => ["open", "in_progress"].includes(o.status)).length
  );
  $("stat-completed-orders").textContent = numberFmt.format(
    ordersCache.filter((o) => o.status === "completed").length
  );

  if (isMaster) {
    const stockValue = articlesCache.reduce(
      (sum, a) => sum + Number(a.quantity || 0) * Number(a.unit_price || 0),
      0
    );
    $("stat-stock-value").textContent = money.format(stockValue);
  }

  const recent = isMaster
    ? ordersCache.slice(0, 5)
    : ordersCache.filter((o) => ["open", "in_progress"].includes(o.status)).slice(0, 8);

  $("recent-orders").innerHTML = recent.length
    ? recent.map((o) => `
      <div class="order-card">
        <div class="order-card-main">
          <strong>${escapeHtml(o.description)}</strong>
          <div class="muted">${escapeHtml(o.code)}</div>
        </div>
        <div class="order-card-actions">
          <span class="badge ${escapeHtml(o.status)}">${statusLabel(o.status)}</span>
          ${!isMaster && ["open", "in_progress"].includes(o.status)
            ? `<button class="btn primary small dashboard-open-work" type="button" data-id="${o.id}">Apri</button>`
            : ""}
        </div>
      </div>
    `).join("")
    : `<div class="empty">${isMaster ? "Nessuna lavorazione presente." : "Nessuna lavorazione da eseguire."}</div>`;
}

$("recent-orders").addEventListener("click", async (event) => {
  const button = event.target.closest(".dashboard-open-work");
  if (button) await openWorkOrder(Number(button.dataset.id));
});

async function boot() {
  $("release-label").textContent = APP_VERSION;

  try {
    const { data: { session }, error } = await db.auth.getSession();
    if (error) throw error;

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
  } catch (err) {
    console.error(err);
    leaveApp();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(console.error);
  }
}

boot();
