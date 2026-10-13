const fs = require("fs"),
  path = require("path"),
  ts = require("typescript");
const { createHash } = require("crypto");
const root = process.env.ADMIN_WORKSPACE || path.resolve(__dirname, "../../..");
const engines = [];
function literal(n) {
  if (!n) return undefined;
  if (
    ts.isAsExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isTypeAssertionExpression(n)
  )
    return literal(n.expression);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(n) &&
    n.operator === ts.SyntaxKind.MinusToken
  ) {
    const v = literal(n.operand);
    return typeof v === "number" ? -v : undefined;
  }
  if (ts.isArrayLiteralExpression(n)) {
    const a = n.elements.map(literal);
    return a.some((x) => x === undefined) ? undefined : a;
  }
  if (ts.isObjectLiteralExpression(n)) {
    const o = {};
    for (const p of n.properties) {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const v = literal(p.initializer);
      if (v === undefined) return undefined;
      const k =
        ts.isIdentifier(p.name) ||
        ts.isStringLiteral(p.name) ||
        ts.isNumericLiteral(p.name)
          ? p.name.text
          : undefined;
      if (k === undefined) return undefined;
      o[k] = v;
    }
    return o;
  }
  if (ts.isCallExpression(n) && n.expression.getText() === "Object.freeze")
    return literal(n.arguments[0]);
  return undefined;
}
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((x) =>
      x.isDirectory() ? walk(path.join(dir, x.name)) : [path.join(dir, x.name)],
    )
    .filter((x) => x.endsWith(".ts"));
}
function make(id, label, desc) {
  const e = { id, label, description: desc, documents: [], rules: [] };
  engines.push(e);
  return e;
}
function doc(e, label, file, status = "data", value) {
  e.documents.push({
    id:
      e.id +
      "-" +
      createHash("sha256")
        .update(
          (file ? path.relative(root, file) : "contract") +
            "|" +
            status +
            "|" +
            (label.endsWith("pořadí pravidla") ? "order" : "values"),
        )
        .digest("hex")
        .slice(0, 20),
    label,
    source: file ? path.relative(root, file) : "Návrh konfiguračního kontraktu",
    status,
    value:
      value === undefined ? JSON.parse(fs.readFileSync(file, "utf8")) : value,
  });
}
function scan(e, files) {
  for (const f of [...new Set(files)].sort()) {
    const source = fs.readFileSync(f, "utf8"),
      sf = ts.createSourceFile(f, source, ts.ScriptTarget.Latest, true);
    const constants = [],
      contracts = [],
      policies = [];
    function visit(n) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const value = literal(n.initializer);
        if (
          value !== undefined &&
          (typeof value === "number" ||
            typeof value === "boolean" ||
            Array.isArray(value) ||
            (value && typeof value === "object"))
        ) {
          constants.push({
            key: n.name.text,
            line: sf.getLineAndCharacterOfPosition(n.pos).line + 1,
            value,
          });
        }
      }
      if (ts.isInterfaceDeclaration(n)) {
        contracts.push({
          name: n.name.text,
          fields: n.members
            .filter(ts.isPropertySignature)
            .map((m) => ({
              name: m.name.getText(sf),
              optional: !!m.questionToken,
              type: m.type ? m.type.getText(sf) : "unknown",
            })),
        });
      }
      if (ts.isClassDeclaration(n)) {
        const fields = n.members
          .filter(ts.isPropertyDeclaration)
          .filter((m) => ["name", "priority"].includes(m.name.getText(sf)));
        const p = {};
        for (const m of fields) p[m.name.getText(sf)] = literal(m.initializer);
        if (Object.keys(p).length) policies.push({ class: n.name?.text, ...p });
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
    const rel = path.relative(root, f);
    e.rules.push({
      name: path.basename(f, ".ts"),
      source: rel,
      contracts,
      constants,
      policies,
      summary: (source.match(/\/\*\*?([\s\S]*?)\*\//)?.[1] || "")
        .replace(/^\s*\*\s?/gm, "")
        .trim()
        .slice(0, 700),
    });
    if (constants.length)
      doc(
        e,
        path.basename(f, ".ts") + " — hodnoty v kódu",
        f,
        "code",
        Object.fromEntries(
          constants.map((c) => [c.key + " · řádek " + c.line, c.value]),
        ),
      );
    if (policies.length)
      doc(
        e,
        path.basename(f, ".ts") + " — pořadí pravidla",
        f,
        "code",
        policies,
      );
  }
}
for (const repo of ["okfish-pricing-engine", "pricing-engine-platform"]) {
  const e = make(
    repo,
    repo === "okfish-pricing-engine"
      ? "OKFISH · cenový engine"
      : "Pricing Platform · cenový engine",
    "Věrnostní úrovně, limity značek a kategorií, kupóny, výjimky a pořadí výpočtu. Každá varianta má vlastní konfiguraci.",
  );
  for (const filename of ["policy-v1.json", "coupon-policy.json"])
    doc(
      e,
      filename === "policy-v1.json"
        ? "Cenová politika — všechny hodnoty"
        : "Kupóny — režim, stropy a výjimky",
      `${root}/${repo}/src/config/policies/${filename}`,
    );
  scan(
    e,
    [
      "src/policies",
      "src/coupon",
      "src/promo",
      "src/voucher",
      "cloudflare-worker/src/engine",
      "cloudflare-worker/src/coupon",
    ]
      .flatMap((d) => walk(`${root}/${repo}/${d}`))
      .concat(
        `${root}/${repo}/src/core/config.ts`,
        `${root}/${repo}/src/core/EngineBuilder.ts`,
      ),
  );
}
const safe = make(
  "safeorder",
  "SafeOrder · rizikové enginy",
  "Rozhodovací politika, váhy signálů, kalibrace, ekonomika, učení, retence a možnosti integrací.",
);
doc(
  safe,
  "Rozhodovací politika — existující API",
  root + "/safeorder-3.0/src/core/types.ts",
  "api",
  {
    reviewThreshold: 0.8,
    restrictThreshold: 1.8,
    codPolicyAction: "RESTRICT_COD",
    fallbackBehavior: "ALLOW",
    networkEnabled: false,
    signalRetentionDays: 90,
  },
);
doc(
  safe,
  "Ekonomický profil — návrh vstupu",
  root + "/safeorder-3.0/src/core/types.ts",
  "contract",
  {
    currency: "EUR",
    average_order_value: 50,
    product_margin_rate: 0.4,
    shipping_cost_outbound: 4.5,
    shipping_cost_return: 4.5,
    restock_packaging_cost: 2,
    payment_processing_rate: null,
    cod_handling_fee: null,
    customer_friction_cost: 6,
  },
);
scan(
  safe,
  [
    "risk-engine",
    "policy-engine",
    "calibration",
    "economics",
    "risk-graph",
    "learning",
    "privacy",
    "billing",
    "capabilities",
    "validation",
    "normalization",
  ].flatMap((d) => walk(root + "/safeorder-3.0/src/core/" + d)),
);
const tut = make(
  "tutani",
  "Tutani · BARF enginy",
  "Celá matice dávek, řešení překryvů, složení, diagnózy, podmínky, priority, suroviny, výživové cíle, doplňky a katalogová pravidla.",
);
const labels = {
  "barf-core": "Dávkovací matice a složení",
  "tutani-health": "Diagnózy a všechna zdravotní pravidla",
  ingredients: "Suroviny, alergeny a skupiny",
  "ingredients-nutrition": "Výživové hodnoty surovin",
  "fediaf-2025": "Nutriční cíle FEDIAF",
  "barf-safety": "Rizika, přechod a varování",
  "tutani-supplements": "Doplňky a dávkovací údaje",
  "tutani-products": "Produkty a složení",
  "tutani-catalog-categories": "Kategorie katalogu",
};
for (const f of fs
  .readdirSync(root + "/tutani-barf-worker/tenants/tutani/rules")
  .filter((f) => f.endsWith(".json"))
  .sort())
  doc(
    tut,
    labels[f.replace(".json", "")] || f,
    root + "/tutani-barf-worker/tenants/tutani/rules/" + f,
  );
const tenantFile = root + "/tutani-barf-worker/tenants/tutani/config/tenant.ts";
const tenantSF = ts.createSourceFile(
  tenantFile,
  fs.readFileSync(tenantFile, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
for (const st of tenantSF.statements)
  if (ts.isVariableStatement(st))
    for (const d of st.declarationList.declarations)
      if (d.name.getText() === "TUTANI_TENANT")
        doc(
          tut,
          "Obchod, mapování kategorií, aktivity, obaly a recept",
          tenantFile,
          "data",
          literal(d.initializer),
        );
scan(
  tut,
  ["src/rules", "src/engine", "src/domain"].flatMap((d) =>
    walk(root + "/tutani-barf-worker/" + d),
  ),
);
const names = {
  pricing: "Ceny a promo pravidla",
  campaign: "Kampaně a kreativy",
  safeorder: "Riziko a ochrana objednávek",
  voucher: "Poukazy",
  availability: "Dostupnost a jednotky",
  procurement: "Nákup a dodavatelé",
  omega: "Účetnictví a mapování",
  billing: "Tarify a předplatné",
  b2b: "B2B profily",
  invoice: "Doklady",
  warehouse: "Sklad",
  shoptet: "Shoptet import",
  "supplier-csv": "Dodavatelské CSV",
};
for (const [domain, label] of Object.entries(names)) {
  const e = make(
    "nexus-" + domain,
    "NEXUS · " + label,
    "Inventář existujících pravidel a jejich vstupních kontraktů. Zpřístupnění přes společnou administraci vyžaduje konfigurační API.",
  );
  if (domain === "pricing")
    doc(
      e,
      "Výchozí cenová konfigurace",
      root +
        "/nexus/connectors/pricing-engine/legacy/config/policies/policy-v1.json",
    );
  scan(e, walk(root + "/nexus/domains/" + domain));
}
const result = {
  generatedAt: new Date().toISOString(),
  engines,
  notes: [
    "JSON dokumenty jsou úplné kopie konfigurací a znalostních sad; statické TS hodnoty jsou návrhy pro budoucí externalizaci.",
    "Vstupní kontrakty obsahují také provozní data. Ne každý vstup je administrátorské nastavení.",
    "Úplnost inventáře se vztahuje na explicitně zahrnuté business adresáře, ne na veškeré síťové adaptéry nebo libovolný výraz v kódu.",
  ],
};
fs.writeFileSync(
  path.join(__dirname, "public/catalog.json"),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    engines: engines.length,
    documents: engines.reduce((a, e) => a + e.documents.length, 0),
    ruleModules: engines.reduce((a, e) => a + e.rules.length, 0),
  }),
);
