// app.js (fragshop) - Inventory from GitHub Issues + Formspree reservation modal
const cfg = window.SHOP_CONFIG;

const els = {
  refreshBtn: document.getElementById("refreshBtn"),
  inventoryRepoLink: document.getElementById("inventoryRepoLink"),

  searchInput: document.getElementById("searchInput"),
  houseSelect: document.getElementById("houseSelect"),
  sortSelect: document.getElementById("sortSelect"),
  statusLine: document.getElementById("statusLine"),

  houseList: document.getElementById("houseList"),
  countChip: document.getElementById("countChip"),
  banner: document.getElementById("banner"),
  list: document.getElementById("list"),
  toast: document.getElementById("toast"),

  // Modal bits
  reserveModal: document.getElementById("reserveModal"),
  reserveForm: document.getElementById("reserveForm"),
  reserveTitle: document.getElementById("reserveTitle"),
  reserveSubtitle: document.getElementById("reserveSubtitle"),
  reserveSubmitBtn: document.getElementById("reserveSubmitBtn"),

  rf_name: document.getElementById("rf_name"),
  rf_contact: document.getElementById("rf_contact"),
  rf_payment: document.getElementById("rf_payment"),
  rf_delivery: document.getElementById("rf_delivery"),
  rf_notes: document.getElementById("rf_notes"),

  rf_item: document.getElementById("rf_item"),
  rf_inventory_link: document.getElementById("rf_inventory_link"),
  rf_price: document.getElementById("rf_price"),
  rf_ml: document.getElementById("rf_ml"),
  rf_type: document.getElementById("rf_type"),
  rf_house: document.getElementById("rf_house"),
  rf_fragrance: document.getElementById("rf_fragrance"),
};

const state = {
  all: [],
  filtered: [],
  houseFocus: "",
  expandedHouses: new Set(),

  // current selected item for reservation
  reserveItem: null,
};

const CACHE_KEY = "shop_cache_v1";
const ETAG_KEY  = "shop_etag_v1";
const CACHE_TTL_MS = 1000 * 60 * (cfg.cacheMinutes || 10);

// Image config
const IMG_DIR = (cfg.imgDir || "imgs").replace(/^\/+/, "").replace(/\/+$/, "");
const IMG_EXTS = (cfg.imgExts || ["png","jpg","jpeg","webp"]);
const IMG_CACHE = new Map(); // key -> resolved url or ""

init();

function init(){
  // ✅ Safe: repo link can be removed from HTML without crashing.
  if (els.inventoryRepoLink){
    els.inventoryRepoLink.href = `https://github.com/${cfg.inventoryOwner}/${cfg.inventoryRepo}`;
    els.inventoryRepoLink.textContent = `${cfg.inventoryOwner}/${cfg.inventoryRepo}`;
  }

  els.refreshBtn?.addEventListener("click", loadAll);

  els.searchInput?.addEventListener("input", () => {
    if ((els.searchInput.value || "").trim()) state.houseFocus = "";
    applyFilters();
  });

  els.houseSelect?.addEventListener("change", () => {
    state.houseFocus = els.houseSelect.value || "";
    applyFilters();
  });

  els.sortSelect?.addEventListener("change", applyFilters);

  els.houseList?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-house]");
    if (!row) return;
    const house = row.getAttribute("data-house") || "";
    if (!house) return;

    if (state.houseFocus === house) setHouseFocus("");
    else setHouseFocus(house);
  });

  // Reserve modal close actions (backdrop, X, cancel)
  if (els.reserveModal){
    els.reserveModal.addEventListener("click", (e) => {
      const close = e.target.closest("[data-close-modal]");
      if (close) closeReserveModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isReserveModalOpen()) closeReserveModal();
    });
  }

  // Reserve form submit -> Formspree
  els.reserveForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await submitReservationToFormspree();
  });

  els.list?.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-toggle-house]");
    if (toggle){
      const house = toggle.getAttribute("data-toggle-house") || "";
      if (!house) return;
      if (state.expandedHouses.has(house)) state.expandedHouses.delete(house);
      else state.expandedHouses.add(house);
      render();
      return;
    }

    // Image fallback handling (if an image fails to load)
    const img = e.target.closest("img[data-img-key]");
    if (img && img.dataset && img.dataset.imgKey){
      // No-op here; errors handled by onerror inline.
    }

    const reserve = e.target.closest("[data-reserve-item]");
    if (reserve){
      const raw = reserve.getAttribute("data-reserve-item") || "";
      try{
        const it = JSON.parse(raw);
        openReserveModal(it);
      }catch{
        toast("Could not open reservation form.", true);
      }
      return;
    }
  });

  loadAll();
}

function setHouseFocus(house){
  state.houseFocus = (house || "").trim();
  if (els.houseSelect) els.houseSelect.value = state.houseFocus;
  if (state.houseFocus && els.searchInput) els.searchInput.value = "";
  applyFilters();
  try{ els.list.scrollIntoView({ behavior: "smooth", block: "start" }); }catch{}
}

function apiBase(){
  return `https://api.github.com/repos/${cfg.inventoryOwner}/${cfg.inventoryRepo}`;
}

function inventoryQueryUrl(page){
  const labels = encodeURIComponent(`${cfg.inventoryListLabel},${cfg.inStockLabel}`);
  return `${apiBase()}/issues?state=open&per_page=100&page=${page}&labels=${labels}`;
}

async function ghFetch(url, { useEtag = false } = {}){
  const headers = { "Accept": "application/vnd.github+json" };
  if (useEtag){
    const et = localStorage.getItem(ETAG_KEY);
    if (et) headers["If-None-Match"] = et;
  }

  const res = await fetch(url, { headers });

  if (res.status === 304) return { __notModified: true };

  if (res.status === 403 || res.status === 429){
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(buildRateLimitMessage(remaining, reset));
  }

  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`GitHub API error ${res.status}: ${txt || res.statusText}`);
  }

  const etag = res.headers.get("etag");
  if (useEtag && etag) localStorage.setItem(ETAG_KEY, etag);

  return res.json();
}

function buildRateLimitMessage(remaining, resetEpoch){
  let msg = "GitHub rate limit hit while loading inventory.";
  if (remaining !== null && remaining !== undefined) msg += ` Remaining: ${remaining}.`;
  if (resetEpoch){
    const ms = Number(resetEpoch) * 1000;
    if (Number.isFinite(ms)){
      const mins = Math.max(1, Math.ceil((ms - Date.now()) / 60000));
      msg += ` Try again in about ${mins} minute${mins === 1 ? "" : "s"}.`;
    }
  }
  return msg;
}

function saveCache(items){
  const payload = { ts: Date.now(), items };
  localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
}
function loadCache(){
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload?.ts || !Array.isArray(payload.items)) return null;
    return payload;
  }catch{
    return null;
  }
}
function isCacheFresh(payload){
  return payload && (Date.now() - payload.ts) < CACHE_TTL_MS;
}

async function loadAll(){
  if (els.banner) els.banner.innerHTML = "";
  try{
    if (els.refreshBtn) els.refreshBtn.textContent = "Refreshing…";
    if (els.statusLine) els.statusLine.textContent = "Loading inventory…";

    const cached = loadCache();
    if (cached && isCacheFresh(cached) && state.all.length === 0){
      state.all = cached.items.map(normalizeIssue);
      applyFilters();
    }

    const firstUrl = inventoryQueryUrl(1);
    const first = await ghFetch(firstUrl, { useEtag: true });

    if (first && first.__notModified){
      const c = loadCache();
      if (c?.items){
        state.all = c.items.map(normalizeIssue);
        applyFilters();
        if (els.statusLine) els.statusLine.textContent = "Loaded (cached, unchanged).";
        return;
      }
      const retry = await ghFetch(firstUrl, { useEtag: false });
      await loadRemainingPages([ ...retry ]);
      return;
    }

    await loadRemainingPages([ ...first ]);
  }catch(err){
    const cached = loadCache();
    if (cached?.items){
      state.all = cached.items.map(normalizeIssue);
      applyFilters();
      if (els.banner) els.banner.innerHTML = `<div class="banner"><b>Using last saved data.</b> ${escapeHtml(err.message)}</div>`;
      if (els.statusLine) els.statusLine.textContent = "Loaded (cached).";
      return;
    }

    if (els.banner) els.banner.innerHTML = `<div class="banner"><b>Couldn’t load inventory.</b> ${escapeHtml(err.message)}</div>`;
    if (els.statusLine) els.statusLine.textContent = "Error loading inventory.";
    state.all = [];
    applyFilters();
  }finally{
    if (els.refreshBtn) els.refreshBtn.textContent = "Refresh";
  }
}

async function loadRemainingPages(firstPageItems){
  let allRaw = firstPageItems.filter(x => !x.pull_request);

  let page = 2;
  while (true){
    if (firstPageItems.length < 100 && page === 2) break;

    const url = inventoryQueryUrl(page);
    const chunk = await ghFetch(url);
    const issuesOnly = chunk.filter(x => !x.pull_request);
    allRaw = allRaw.concat(issuesOnly);
    if (chunk.length < 100) break;
    page++;
    if (page > 10) break;
  }

  saveCache(allRaw);
  state.all = allRaw.map(normalizeIssue);
  applyFilters();
  if (els.statusLine) els.statusLine.textContent = `Loaded ${state.all.length} items.`;
}

function normalizeIssue(issue){
  const labels = (issue.labels || []).map(l => (typeof l === "string" ? l : l.name)).filter(Boolean);
  const parsed = parseIssueBody(issue.body || "");
  const inferred = inferFromTitle(issue.title || "");

  const designHouse = parsed.design_house || inferred.design_house || "Unknown";
  const fragranceName = parsed.fragrance_name || inferred.fragrance_name || (issue.title || "");
  const type = (parsed.type || inferred.type || "").toUpperCase();
  const ml = toNum(parsed.ml || inferred.ml);

  const desiredSell = toNum(parsed.desired_sell);
  const desiredPerMl = (ml && desiredSell) ? (desiredSell / ml) : null;
  const sample10Price = (desiredPerMl && Number.isFinite(desiredPerMl)) ? (desiredPerMl * 10) : null;

  const sourceLink = parsed.source_link || "";

  // Image key + candidates
  const img = resolveImageMeta({ designHouse, fragranceName });

  return {
    id: issue.id,
    number: issue.number,
    url: issue.html_url,
    updated_at: issue.updated_at,

    labels,
    designHouse,
    fragranceName,
    type,
    ml,

    desiredSell,
    desiredPerMl,
    sample10Price,

    sourceLink,

    img, // { key, candidates[] }
  };
}

function inferFromTitle(title){
  const out = {};
  const t = title.replace(/^\[[^\]]+\]\s*/,"").trim();

  const mlMatch = t.match(/(\d+(?:\.\d+)?)\s*(ml|mL)\b/);
  if (mlMatch) out.ml = mlMatch[1];

  const typeMatch = t.match(/\b(EDP|EDT|PARFUM|EXTRAIT|EDC|COLOGNE)\b/i);
  if (typeMatch) out.type = typeMatch[1].toUpperCase();

  const parts = t.split(" - ");
  if (parts.length >= 2){
    out.design_house = parts[0].trim();
    out.fragrance_name = parts.slice(1).join(" - ").trim().replace(/\s*\(.*?\)\s*/g,"").trim();
  }
  return out;
}

function parseIssueBody(body){
  const fields = ["design_house","fragrance_name","type","ml","desired_sell","source_link"];
  const map = {};
  for (const f of fields){
    const label = toHeadingLabel(f);
    const val = readHeadingValue(body, label);
    if (val) map[f] = val;
  }
  return map;
}

function toHeadingLabel(field){
  switch(field){
    case "design_house": return "Design House";
    case "fragrance_name": return "Fragrance Name";
    case "type": return "Type";
    case "ml": return "Size (mL)";
    case "desired_sell": return "Desired Sell Price (USD)";
    case "source_link": return "Source Link (optional)";
    default: return field;
  }
}

function readHeadingValue(markdown, headingText){
  const re = new RegExp(`^###\\s+${escapeRegExp(headingText)}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|$)`, "m");
  const m = markdown.match(re);
  if (!m) return "";
  let v = (m[1] || "").trim();
  v = v.replace(/\r/g,"");
  v = v.replace(/^_No response_$/i,"").trim();
  return v;
}

function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function toNum(x){
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g,""));
  return Number.isFinite(n) ? n : null;
}

function applyFilters(){
  const q = (els.searchInput?.value || "").trim().toLowerCase();
  const sort = els.sortSelect?.value || "updated_desc";
  const house = state.houseFocus || "";

  let items = [...state.all];

  if (house){
    items = items.filter(it => (it.designHouse || "Unknown") === house);
  }

  if (q){
    items = items.filter(it => {
      const hay = [
        it.designHouse, it.fragranceName, it.type,
        String(it.ml ?? ""),
        (it.labels || []).join(" "),
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  items = sortItems(items, sort);

  state.filtered = items;
  rebuildHouseUI();
  render();
}

function sortItems(items, mode){
  const copy = [...items];
  switch(mode){
    case "updated_desc":
      return copy.sort((a,b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    case "price_asc":
      return copy.sort((a,b) => (a.desiredSell ?? Infinity) - (b.desiredSell ?? Infinity));
    case "price_desc":
      return copy.sort((a,b) => (b.desiredSell ?? -Infinity) - (a.desiredSell ?? -Infinity));
    case "house_asc":
      return copy.sort((a,b) => (a.designHouse||"").localeCompare(b.designHouse||""));
    case "name_asc":
      return copy.sort((a,b) => (a.fragranceName||"").localeCompare(b.fragranceName||""));
    default:
      return copy;
  }
}

function rebuildHouseUI(){
  const q = (els.searchInput?.value || "").trim().toLowerCase();
  let base = [...state.all];

  if (q){
    base = base.filter(it => {
      const hay = [
        it.designHouse, it.fragranceName, it.type,
        String(it.ml ?? ""),
        (it.labels || []).join(" "),
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  const groups = groupByHouse(base);
  const houses = Array.from(groups.keys()).sort((a,b)=>a.localeCompare(b));
  const current = state.houseFocus || "";

  if (els.houseSelect){
    els.houseSelect.innerHTML = `<option value="">All houses</option>` + houses.map(h => {
      const sel = (h === current) ? ` selected` : ``;
      return `<option value="${escapeAttr(h)}"${sel}>${escapeHtml(h)}</option>`;
    }).join("");
  }

  if (els.houseList){
    els.houseList.innerHTML = houses.map(h => {
      const arr = groups.get(h) || [];
      const count = arr.length;
      const ml = sum(arr.map(x => x.ml).filter(Boolean));
      const desired = sum(arr.map(x => x.desiredSell).filter(Boolean));
      const active = (current === h) ? " active" : "";

      const meta = [
        ml ? `${ml.toFixed(0)} mL` : null,
        desired ? `Value ${money(desired)}` : null,
      ].filter(Boolean).join(" • ");

      return `
        <div class="houseRow${active}" data-house="${escapeAttr(h)}">
          <div class="name">${escapeHtml(h)}</div>
          <div class="count">${count}</div>
          <div class="meta">${escapeHtml(meta || "—")}</div>
        </div>
      `;
    }).join("") || `<div class="meta">No houses.</div>`;
  }
}

function render(){
  if (els.countChip) els.countChip.textContent = `${state.filtered.length} item${state.filtered.length===1?"":"s"}`;

  if (!state.filtered.length){
    if (els.list) els.list.innerHTML = `<div class="banner">No matches.</div>`;
    return;
  }

  const groups = groupByHouse(state.filtered);
  const houses = Array.from(groups.keys()).sort((a,b)=>a.localeCompare(b));

  if (!els.list) return;

  els.list.innerHTML = houses.map(house => {
    const arr = groups.get(house) || [];
    const expanded = state.expandedHouses.has(house);
    const visibleCount = expanded ? arr.length : Math.min(cfg.housePreviewCount || 4, arr.length);
    const hiddenCount = Math.max(0, arr.length - visibleCount);

    const ml = sum(arr.map(x => x.ml).filter(Boolean));
    const desired = sum(arr.map(x => x.desiredSell).filter(Boolean));

    const meta = [
      `${arr.length} item${arr.length===1?"":"s"}`,
      ml ? `${ml.toFixed(0)} mL` : null,
      desired ? `Value ${money(desired)}` : null,
    ].filter(Boolean).join(" • ");

    const toggleText = expanded ? "Show less" : (hiddenCount ? `Show ${hiddenCount} more` : "");
    const toggleBtn = (hiddenCount || expanded)
      ? `<button class="badge" data-toggle-house="${escapeAttr(house)}" style="cursor:pointer;">${escapeHtml(toggleText)}</button>`
      : "";

    const cards = arr.slice(0, visibleCount).map(renderCard).join("");

    return `
      <div class="section">
        <div class="sectionHead">
          <div>
            <div class="sectionName">${escapeHtml(house)}</div>
            <div class="sectionMeta">${escapeHtml(meta || "—")}</div>
          </div>
          <div class="badges">${toggleBtn}</div>
        </div>
        <div class="sectionBody">${cards}</div>
      </div>
    `;
  }).join("");
}

/**
 * Shopify-ish product card:
 * - Image left
 * - Title/subtitle center
 * - Price + actions right
 */
function renderCard(it){
  const imgHtml = renderImage(it);

  // Put only the fields we need into the data payload
  const payload = {
    designHouse: it.designHouse || "Unknown",
    fragranceName: it.fragranceName || "Unknown",
    type: it.type || "",
    ml: it.ml ?? null,
    desiredSell: it.desiredSell ?? null,
    url: it.url || "",
  };

  return `
    <div class="card productCard">
      <div class="productMedia">
        ${imgHtml}
      </div>

      <div class="productMain">
        <div class="cardTitle">${escapeHtml(it.fragranceName)}</div>
        <div class="cardSub">${escapeHtml([it.designHouse, it.type, it.ml ? `${it.ml} mL` : null].filter(Boolean).join(" • ") || "—")}</div>

        <div class="kv compact">
          <div class="box">
            <div class="k">Price</div>
            <div class="v">${money(it.desiredSell)}</div>
          </div>
          <div class="box">
            <div class="k">$/mL</div>
            <div class="v">${money4(it.desiredPerMl)}</div>
          </div>
          <div class="box">
            <div class="k">10mL</div>
            <div class="v">${money2(it.sample10Price)}</div>
          </div>
          <div class="box">
            <div class="k">Source</div>
            <div class="v">${it.sourceLink ? `<a href="${escapeAttr(it.sourceLink)}" target="_blank" rel="noreferrer">Link</a>` : "—"}</div>
          </div>
        </div>
      </div>

      <div class="productActions">
        <div class="priceBig">${money(it.desiredSell)}</div>
        <div class="badges actions">
          ${it.type ? `<span class="badge">${escapeHtml(it.type)}</span>` : ""}
          ${it.ml ? `<span class="badge">${escapeHtml(String(it.ml))} mL</span>` : ""}
          <a class="badge" href="${escapeAttr(it.url)}" target="_blank" rel="noreferrer">Listing</a>

          <!-- Reserve via Formspree modal -->
          <button class="badge good"
                  type="button"
                  data-reserve-item="${escapeAttr(JSON.stringify(payload))}">
            Reserve
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderImage(it){
  const meta = it.img || resolveImageMeta({ designHouse: it.designHouse, fragranceName: it.fragranceName });
  const key = meta.key;

  // If we already resolved a working url for this key, reuse it.
  const cached = IMG_CACHE.get(key);
  if (cached){
    return `<img class="productImg" src="${escapeAttr(cached)}" alt="${escapeAttr(it.fragranceName)}" loading="lazy" decoding="async" />`;
  }

  // We start with the first candidate; onerror rotates through candidates then uses placeholder.
  const first = meta.candidates[0] || "";
  const onerr = `
    (function(img){
      const key = img.dataset.imgKey;
      const list = (img.dataset.imgCandidates||"").split("|").filter(Boolean);
      let i = Number(img.dataset.imgIndex||"0");
      i++;
      if (i < list.length){
        img.dataset.imgIndex = String(i);
        img.src = list[i];
        return;
      }
      img.classList.add("productImg--placeholder");
      img.removeAttribute("src");
      img.alt = "No image";
    })(this);
  `.trim().replace(/\s+/g," ");

  // If first is empty, render placeholder
  if (!first){
    return `<div class="productImg productImg--placeholder" aria-label="No image"></div>`;
  }

  return `
    <img class="productImg"
         src="${escapeAttr(first)}"
         alt="${escapeAttr(it.fragranceName)}"
         loading="lazy"
         decoding="async"
         data-img-key="${escapeAttr(key)}"
         data-img-index="0"
         data-img-candidates="${escapeAttr(meta.candidates.join("|"))}"
         onerror="${escapeAttr(onerr)}"
         onload="${escapeAttr(`(function(img){ try{ IMG_CACHE.set(img.dataset.imgKey, img.currentSrc || img.src); }catch{} })(this);`)}"
    />
  `;
}

function resolveImageMeta({ designHouse, fragranceName }){
  const houseSlug = slugify(designHouse || "");
  const nameSlug = slugify(fragranceName || "");
  const key = `${houseSlug}__${nameSlug}`;

  const candidates = [];
  if (houseSlug && nameSlug){
    for (const ext of IMG_EXTS) candidates.push(`${IMG_DIR}/${houseSlug}-${nameSlug}.${ext}`);
  }
  if (nameSlug){
    for (const ext of IMG_EXTS) candidates.push(`${IMG_DIR}/${nameSlug}.${ext}`);
  }

  return { key, candidates };
}

function slugify(s){
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* ---------------------------
   Formspree Reservation Modal
---------------------------- */

function isReserveModalOpen(){
  return !!(els.reserveModal && els.reserveModal.classList.contains("is-open"));
}

function openReserveModal(it){
  if (!els.reserveModal || !els.reserveForm){
    // Fallback: open Formspree endpoint directly if modal isn't present
    toast("Reservation form is not installed in the page.", true);
    return;
  }

  state.reserveItem = it;

  const title = `${it.fragranceName || "Item"}${it.ml ? ` (${it.ml} mL)` : ""}`;
  const sub = `${it.designHouse || "Unknown"}${it.type ? ` • ${it.type}` : ""}${Number.isFinite(it.desiredSell) ? ` • ${money(it.desiredSell)}` : ""}`;

  if (els.reserveTitle) els.reserveTitle.textContent = "Reserve";
  if (els.reserveSubtitle) els.reserveSubtitle.textContent = `${title} — ${sub}`;

  // Fill hidden item fields
  if (els.rf_item) els.rf_item.value = `${it.designHouse || "Unknown"} - ${it.fragranceName || "Unknown"}`.trim();
  if (els.rf_inventory_link) els.rf_inventory_link.value = it.url || "";
  if (els.rf_price) els.rf_price.value = Number.isFinite(it.desiredSell) ? money(it.desiredSell) : "";
  if (els.rf_ml) els.rf_ml.value = (it.ml ?? "") ? String(it.ml) : "";
  if (els.rf_type) els.rf_type.value = it.type || "";
  if (els.rf_house) els.rf_house.value = it.designHouse || "Unknown";
  if (els.rf_fragrance) els.rf_fragrance.value = it.fragranceName || "Unknown";

  // Clear user fields (optional: keep values if you prefer)
  if (cfg.keepReservationFields !== true){
    if (els.rf_payment) els.rf_payment.value = "";
    if (els.rf_delivery) els.rf_delivery.value = "";
    if (els.rf_notes) els.rf_notes.value = "";
  }

  els.reserveModal.classList.add("is-open");
  els.reserveModal.setAttribute("aria-hidden", "false");
  try{ els.rf_name?.focus(); }catch{}
}

function closeReserveModal(){
  if (!els.reserveModal) return;
  els.reserveModal.classList.remove("is-open");
  els.reserveModal.setAttribute("aria-hidden", "true");
  state.reserveItem = null;
}

async function submitReservationToFormspree(){
  const endpoint = (cfg.formspreeEndpoint || "").trim();
  if (!endpoint){
    toast("Formspree endpoint not configured in SHOP_CONFIG.", true);
    return;
  }
  if (!els.reserveForm) return;

  const fd = new FormData(els.reserveForm);

  // Extra helpful meta
  const it = state.reserveItem || {};
  fd.append("submitted_from", location.href);
  fd.append("inventory_repo", `${cfg.inventoryOwner}/${cfg.inventoryRepo}`);

  // Optional subject line many people like in notifications
  const subjPrefix = (cfg.formspreeSubjectPrefix || "FragShop Reserve").trim();
  const subj = `${subjPrefix}: ${(it.designHouse || "Unknown")} - ${(it.fragranceName || "Item")}${it.ml ? ` (${it.ml}mL)` : ""}`;
  fd.append("_subject", subj);

  setReserveSubmitting(true);
  try{
    const res = await fetch(endpoint, {
      method: "POST",
      body: fd,
      headers: { "Accept": "application/json" }
    });

    if (!res.ok){
      let msg = `Form submit failed (${res.status}).`;
      try{
        const j = await res.json();
        if (j?.errors?.length) msg = j.errors.map(e => e.message).join(" • ");
      }catch{}
      throw new Error(msg);
    }

    toast("Reservation sent! I’ll reach out soon.", false);
    els.reserveForm.reset();
    closeReserveModal();
  }catch(err){
    toast(err?.message || "Reservation failed.", true);
  }finally{
    setReserveSubmitting(false);
  }
}

function setReserveSubmitting(isSubmitting){
  if (els.reserveSubmitBtn){
    els.reserveSubmitBtn.disabled = !!isSubmitting;
    els.reserveSubmitBtn.textContent = isSubmitting ? "Sending…" : "Send reservation";
  }
}

/* ---------------------------
   Helpers
---------------------------- */

function groupByHouse(items){
  const m = new Map();
  for (const it of items){
    const key = it.designHouse || "Unknown";
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(it);
  }
  return m;
}

function money(n){
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}
function money2(n){
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}
function money4(n){
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(4)}`;
}
function sum(arr){ return arr.reduce((a,b)=>a+(Number.isFinite(b)?b:0), 0); }

function toast(msg, isBad){
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.classList.toggle("bad", !!isBad);
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=> els.toast.classList.remove("show"), 2600);
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function escapeAttr(s){ return escapeHtml(s).replaceAll("`","&#096;"); }
