// app.js (fragshop) - GitHub-only reservation issues (prefilled)
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
};

const state = {
  all: [],
  filtered: [],
  houseFocus: "",
  expandedHouses: new Set(),
};

const CACHE_KEY = "shop_cache_v1";
const ETAG_KEY  = "shop_etag_v1";
const CACHE_TTL_MS = 1000 * 60 * (cfg.cacheMinutes || 10);

init();

function init(){
  els.inventoryRepoLink.href = `https://github.com/${cfg.inventoryOwner}/${cfg.inventoryRepo}`;
  els.inventoryRepoLink.textContent = `${cfg.inventoryOwner}/${cfg.inventoryRepo}`;

  els.refreshBtn.addEventListener("click", loadAll);

  els.searchInput.addEventListener("input", () => {
    if ((els.searchInput.value || "").trim()) state.houseFocus = "";
    applyFilters();
  });

  els.houseSelect.addEventListener("change", () => {
    state.houseFocus = els.houseSelect.value || "";
    applyFilters();
  });

  els.sortSelect.addEventListener("change", applyFilters);

  els.houseList.addEventListener("click", (e) => {
    const row = e.target.closest("[data-house]");
    if (!row) return;
    const house = row.getAttribute("data-house") || "";
    if (!house) return;

    if (state.houseFocus === house) setHouseFocus("");
    else setHouseFocus(house);
  });

  els.list.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-toggle-house]");
    if (toggle){
      const house = toggle.getAttribute("data-toggle-house") || "";
      if (!house) return;
      if (state.expandedHouses.has(house)) state.expandedHouses.delete(house);
      else state.expandedHouses.add(house);
      render();
      return;
    }

    const reserve = e.target.closest("[data-reserve-url]");
    if (reserve){
      const url = reserve.getAttribute("data-reserve-url") || "";
      const title = reserve.getAttribute("data-reserve-title") || "";
      const body = reserve.getAttribute("data-reserve-body") || "";
      if (!url) return;

      // Open reservation issue in shop repo with prefilled title/body
      const reserveUrl = buildReserveUrl({ title, body });
      window.open(reserveUrl, "_blank", "noopener,noreferrer");
      return;
    }
  });

  loadAll();
}

function setHouseFocus(house){
  state.houseFocus = (house || "").trim();
  els.houseSelect.value = state.houseFocus;
  if (state.houseFocus) els.searchInput.value = "";
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
  els.banner.innerHTML = "";
  try{
    els.refreshBtn.textContent = "Refreshing…";
    els.statusLine.textContent = "Loading inventory…";

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
        els.statusLine.textContent = "Loaded (cached, unchanged).";
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
      els.banner.innerHTML = `<div class="banner"><b>Using last saved data.</b> ${escapeHtml(err.message)}</div>`;
      els.statusLine.textContent = "Loaded (cached).";
      return;
    }

    els.banner.innerHTML = `<div class="banner"><b>Couldn’t load inventory.</b> ${escapeHtml(err.message)}</div>`;
    els.statusLine.textContent = "Error loading inventory.";
    state.all = [];
    applyFilters();
  }finally{
    els.refreshBtn.textContent = "Refresh";
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
  els.statusLine.textContent = `Loaded ${state.all.length} items.`;
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
  const q = (els.searchInput.value || "").trim().toLowerCase();
  const sort = els.sortSelect.value;
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
      return copy.sort((a,b) => (b.updated_at || "").localeCompare(b.updated_at || ""));
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
  const q = (els.searchInput.value || "").trim().toLowerCase();
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

  els.houseSelect.innerHTML = `<option value="">All houses</option>` + houses.map(h => {
    const sel = (h === current) ? ` selected` : ``;
    return `<option value="${escapeAttr(h)}"${sel}>${escapeHtml(h)}</option>`;
  }).join("");

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

function render(){
  els.countChip.textContent = `${state.filtered.length} item${state.filtered.length===1?"":"s"}`;

  if (!state.filtered.length){
    els.list.innerHTML = `<div class="banner">No matches.</div>`;
    return;
  }

  const groups = groupByHouse(state.filtered);
  const houses = Array.from(groups.keys()).sort((a,b)=>a.localeCompare(b));

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

function renderCard(it){
  const fullTitle = `${it.designHouse} - ${it.fragranceName}`.replace(/\s+/g," ").trim();
  const reserveTitle = `[RESERVE] ${fullTitle}${it.ml ? ` (${it.ml}mL)` : ""}`;

  const body = buildReserveBody(it);

  return `
    <div class="card">
      <div class="cardTop">
        <div>
          <div class="cardTitle">${escapeHtml(it.fragranceName)}</div>
          <div class="cardSub">${escapeHtml([it.designHouse, it.type, it.ml ? `${it.ml} mL` : null].filter(Boolean).join(" • ") || "—")}</div>
        </div>
        <div class="badges">
          ${it.type ? `<span class="badge">${escapeHtml(it.type)}</span>` : ""}
          ${it.ml ? `<span class="badge">${escapeHtml(String(it.ml))} mL</span>` : ""}
          <a class="badge" href="${escapeAttr(it.url)}" target="_blank" rel="noreferrer">Listing</a>
          <a class="badge good"
             href="${escapeAttr(buildReserveUrl({ title: reserveTitle, body }))}"
             target="_blank" rel="noreferrer"
             data-reserve-url="${escapeAttr(it.url)}"
             data-reserve-title="${escapeAttr(reserveTitle)}"
             data-reserve-body="${escapeAttr(body)}"
          >Reserve</a>
        </div>
      </div>

      <div class="kv">
        <div class="box">
          <div class="k">Price</div>
          <div class="v">${money(it.desiredSell)}</div>
        </div>
        <div class="box">
          <div class="k">Target $/mL</div>
          <div class="v">${money4(it.desiredPerMl)}</div>
        </div>
        <div class="box">
          <div class="k">Target (10mL)</div>
          <div class="v">${money2(it.sample10Price)}</div>
        </div>
        <div class="box">
          <div class="k">Source</div>
          <div class="v">${it.sourceLink ? `<a href="${escapeAttr(it.sourceLink)}" target="_blank" rel="noreferrer">Link</a>` : "—"}</div>
        </div>
      </div>
    </div>
  `;
}

function buildReserveBody(it){
  const lines = [];
  lines.push(cfg.reservationInstructions || "Fill in your contact info below.");
  lines.push("");
  lines.push("## Item");
  lines.push(`- **House:** ${it.designHouse || "Unknown"}`);
  lines.push(`- **Name:** ${it.fragranceName || "Unknown"}`);
  if (it.type) lines.push(`- **Type:** ${it.type}`);
  if (it.ml) lines.push(`- **Size:** ${it.ml} mL`);
  if (Number.isFinite(it.desiredSell)) lines.push(`- **Price:** ${money(it.desiredSell)}`);
  lines.push(`- **Inventory link:** ${it.url}`);
  lines.push("");
  lines.push("## Your info");
  lines.push("- **Name:** ");
  lines.push("- **Contact (IG/Email/Whatnot):** ");
  lines.push("- **Payment method:** ");
  lines.push("- **Shipping or pickup:** ");
  lines.push("");
  lines.push("## Notes (optional)");
  lines.push("");

  return lines.join("\n");
}

function buildReserveUrl({ title, body }){
  const base = `https://github.com/${cfg.shopOwner}/${cfg.shopRepo}/issues/new`;
  const labels = encodeURIComponent(cfg.reservationLabel || "reservation");
  const t = encodeURIComponent(title || "[RESERVE] Item");
  const b = encodeURIComponent(body || "");
  return `${base}?labels=${labels}&title=${t}&body=${b}`;
}

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

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function escapeAttr(s){ return escapeHtml(s).replaceAll("`","&#096;"); }
