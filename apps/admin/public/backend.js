// Local operator application: persistence is real; production activation is not provided.
const serverRevisions = new Map();
let serverReady = false,
  requestInFlight = false;
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const e = new Error(data.error || "Požadavek selhal.");
    e.status = res.status;
    throw e;
  }
  return data;
}
const originalEditor = renderEditor;
renderEditor = function () {
  originalEditor();
  const d = doc();
  if (d?.source.endsWith("/policy-v1.json")) {
    const button = document.createElement("button");
    button.textContent = "Simulovat skutečný cenový engine";
    button.className = "primary";
    button.onclick = pricingDialog;
    document.querySelector("#editor .toolbar").append(button);
  }
  if (doc()) {
    const refresh = document.createElement("button");
    refresh.textContent = "Obnovit referenční verze ze serveru";
    refresh.onclick = () => bootstrap(true);
    document.querySelector("#editor .toolbar").append(refresh);
  }
};
async function bootstrap(preserveDrafts = false) {
  try {
    const data = await api("/api/bootstrap");
    for (const s of data.shops) {
      for (const c of s.configurations) {
        const k = s.id + "::" + c.id;
        serverRevisions.set(k, c.revision);
        saved.set(k, { revision: c.revision, value: clone(c.configuration) });
        if (!preserveDrafts) {
          if (c.id.startsWith("rule:"))
            ruleDrafts.set(k, clone(c.configuration));
          else working.set(k, clone(c.configuration));
        }
      }
    }
    const select = document.querySelector("#shop"),
      previous = select.value;
    select.innerHTML = data.shops
      .map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`)
      .join("");
    if (data.shops.some((s) => s.id === previous)) select.value = previous;
    serverReady = true;
    document.querySelector("#app").style.pointerEvents = "";
    document.querySelector(".notice").textContent =
      "Lokální administrace NEXUS: změny se ukládají do SQLite a přežijí obnovení stránky i restart serveru. Cenovou politiku lze ověřit skutečným NEXUS enginem. Uložení je návrh; produkční obchod ani další runtime enginy tím nezměníte.";
    render();
    if (preserveDrafts)
      toast(
        "Referenční verze obnoveny. Vaše rozepsané návrhy zůstaly zachované.",
      );
  } catch (e) {
    document.querySelector(".notice").textContent =
      "Administraci se nepodařilo načíst: " + e.message;
    toast(e.message);
  }
}
function payload(id, configuration, whichShop = shop()) {
  return {
    shop: whichShop,
    id,
    baseRevision: serverRevisions.get(whichShop + "::" + id) || 0,
    configuration,
  };
}
async function validateOnServer() {
  if (!serverReady) return;
  if (!validateCurrent()) return;
  try {
    const result = await api(
      "/api/validate",
      payload(doc().id, clone(value())),
    );
    document.querySelector("#validation").innerHTML =
      `<div class="valid">Serverová validace prošla. ${result.consumer === "nexus-pricing-simulation" ? "Konfigurace je použitelná pro cenovou simulaci." : "Sada je uložitelná jako návrh; runtime konzument dosud není připojen."}</div>`;
  } catch (e) {
    document.querySelector("#validation").innerHTML =
      `<div class="error">${esc(e.message)}</div>`;
  }
}
async function saveVersion() {
  if (!serverReady || requestInFlight) return;
  if (!validateCurrent()) return;
  const d = doc(),
    configuration = clone(value()),
    whichShop = shop(),
    id = d.id,
    k = whichShop + "::" + id;
  requestInFlight = true;
  try {
    const result = await api(
      "/api/config",
      payload(id, configuration, whichShop),
    );
    serverRevisions.set(k, result.revision);
    saved.set(k, { revision: result.revision, value: clone(configuration) });
    toast("Verze " + result.revision + " uložena na server jako návrh.");
  } catch (e) {
    toast(e.message);
    if (e.status === 409 && selected === id)
      document.querySelector("#validation").innerHTML =
        `<div class="error">${esc(e.message)} Použijte „Obnovit referenční verze ze serveru“ a zkontrolujte rozdíl před dalším uložením.</div>`;
  } finally {
    requestInFlight = false;
  }
}
async function saveRuleVersion() {
  if (!serverReady || requestInFlight) return;
  const id = "rule:" + selected,
    configuration = clone(ruleValue()),
    whichShop = shop(),
    k = whichShop + "::" + id;
  requestInFlight = true;
  try {
    const result = await api(
      "/api/config",
      payload(id, configuration, whichShop),
    );
    serverRevisions.set(k, result.revision);
    saved.set(k, { revision: result.revision, value: configuration });
    toast(
      "Návrh pravidla uložen na server, revize " +
        result.revision +
        ". Runtime obal ještě není připojen.",
    );
  } catch (e) {
    toast(e.message);
  } finally {
    requestInFlight = false;
  }
}
resetDoc = function () {
  working.set(
    key(doc().id),
    clone(saved.get(key(doc().id))?.value || doc().value),
  );
  renderEditor();
  toast("Návrh vrácen k poslední načtené serverové verzi.");
};
showHistory = async function () {
  try {
    const data = await api("/api/history?shop=" + encodeURIComponent(shop()));
    history.splice(
      0,
      history.length,
      ...data.versions.map((v) => ({
        type: v.document.startsWith("rule:") ? "rule" : "document",
        shop: shop(),
        document: v.label,
        time: new Date(v.created_at).toLocaleString("cs-CZ"),
        revision: v.revision,
        changes: v.diff,
        value: v.configuration,
        id: shop() + "::" + v.document,
        author: v.author,
      })),
    );
    openModal(
      "Serverová historie verzí",
      history.length
        ? `<table><tr><th>Čas / autor</th><th>Sada</th><th>Revize</th><th>Změny</th></tr>${history.map((h, i) => `<tr><td>${esc(h.time)}<br>${esc(h.author)}</td><td>${esc(h.document)}</td><td>${h.revision}</td><td>${h.changes.length} polí <button class="small" onclick="restore(${i})">Načíst do návrhu</button></td></tr>`).join("")}</table>`
        : "Pro tento obchod zatím nejsou uložené žádné změny.",
    );
  } catch (e) {
    toast(e.message);
  }
};
const originalRestore = restore;
restore = function (i) {
  originalRestore(i);
  toast(
    "Historická verze načtena do návrhu. Serverové hodnoty se změní až novým uložením.",
  );
};
function pricingDialog() {
  if (mode === "json" && !applyRaw()) return;
  const tiers = Object.keys(value().loyaltyTiers || {});
  openModal(
    "Simulace skutečným NEXUS enginem",
    `<p class="help">Porovná poslední uloženou konfiguraci s rozepsaným návrhem nad stejným produktem. Zobrazí cenu a skutečně aplikovaná pravidla. Do e-shopu nic nezapisuje.</p><div class="field"><label>Kód produktu</label><input id="sim-sku" value="TEST-001"></div><div class="field"><label>Základní cena</label><input id="sim-base" type="number" min="0" step="0.01" value="100"></div><div class="field"><label>Akční cena (volitelná)</label><input id="sim-sale" type="number" min="0" step="0.01"></div><div class="field"><label>Věrnostní úroveň</label><select id="sim-tier"><option value="">Bez úrovně</option>${tiers.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}</select></div><div class="field"><label>Výrobce</label><input id="sim-brand"></div><div class="field"><label>Kategorie</label><input id="sim-category"></div><div class="field"><label>Produktový strop slevy (0–1)</label><input id="sim-limit" type="number" min="0" max="1" step="0.01"></div><div class="field"><label>Použít věrnostní slevu</label><input id="sim-loyalty" type="checkbox" checked></div><button class="primary" id="simulate">Spočítat porovnání</button><div id="simulation-result" aria-live="polite"></div>`,
  );
  document.querySelector("#simulate").onclick = runSimulation;
}
async function runSimulation() {
  const input = {
    sku: document.querySelector("#sim-sku").value,
    basePrice: document.querySelector("#sim-base").value,
    allowLoyaltyDiscount: document.querySelector("#sim-loyalty").checked,
  };
  for (const [id, key] of [
    ["sim-sale", "salePrice"],
    ["sim-tier", "customerTier"],
    ["sim-brand", "manufacturer"],
    ["sim-category", "category"],
  ]) {
    const v = document.querySelector("#" + id).value;
    if (v) input[key] = v;
  }
  const limit = document.querySelector("#sim-limit").value;
  if (limit !== "") input.productMaxDiscount = Number(limit);
  const el = document.querySelector("#simulation-result"),
    button = document.querySelector("#simulate");
  button.disabled = true;
  try {
    const result = await api("/api/simulate/pricing", {
      ...payload(doc().id, clone(value())),
      input,
    });
    el.innerHTML = `<h3>Výsledek skutečného enginu</h3><table><tr><th></th><th>Uložená revize ${result.baselineRevision}</th><th>Rozepsaný návrh</th></tr><tr><td>Výsledná cena</td><td id="sim-before">${esc(result.before.finalPrice)}</td><td id="sim-after">${esc(result.after.finalPrice)}</td></tr><tr><td>Aplikovaná pravidla</td><td>${result.before.appliedRules.map((r) => esc(r.rule)).join(" → ")}</td><td>${result.after.appliedRules.map((r) => esc(r.rule)).join(" → ")}</td></tr></table><p>Změna ceny: ${esc(result.delta)}</p><p class="hint">Výpočet: createNexusPricingCalculator. Ostatní cenové runtime cesty ani e-shopové zápisy tímto nejsou ověřené.</p>`;
  } catch (e) {
    el.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}
document.querySelector("#app").style.pointerEvents = "none";
document.querySelector(".notice").textContent =
  "Načítám serverové konfigurace…";
bootstrap();
