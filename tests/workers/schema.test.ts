// tests/workers/schema.test.ts -- smoke test migrace 0001_credit_voucher.sql.
//
// PROČ TENHLE SOUBOR EXISTUJE:
//   migrations/0001_credit_voucher.sql tvrdí, že invarianty kreditu jsou
//   vynucené DATABÁZÍ, ne aplikačním kódem ("poslední záchranná síť pod
//   optimistickým zámkem"). Tvrzení bez testu je jen komentář. Každý test
//   níž je PROTO pokus invariant PORUŠIT -- zelený test = DB porušení odmítla.
//
// Testy běží uvnitř workerd proti reálné D1 (miniflare), ne proti mocku:
// CHECK constrainty, partial unique indexy ani `meta.changes` se v mocku
// věrohodně nasimulovat nedají.
//
// KAŽDÝ TEST SI DĚLÁ VLASTNÍ tenant_id / voucher id. D1 v testech je sdílená
// napříč soubory v rámci isolate, takže na globální čistotu se nespoléhá --
// izolace je přes unikátní klíče, ne přes DELETE.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const db = env.DB;

/** Unikátní suffix, ať se testy navzájem nechytají na unique indexech. */
let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

interface VoucherSeed {
  id: string;
  tenantId: string;
  sourceOrderId: string;
  initialMinor: number;
}

/** Založí ACTIVE poukaz s daným zůstatkem (v haléřích) a vrátí jeho klíče. */
async function seedVoucher(initialMinor = 100_00): Promise<VoucherSeed> {
  const seed: VoucherSeed = {
    id: uid("NEXUS-TEST"),
    tenantId: uid("tenant"),
    sourceOrderId: uid("src-order"),
    initialMinor,
  };
  await db
    .prepare(
      `INSERT INTO vouchers (
         id, tenant_id, initial_balance_minor, current_balance_minor,
         currency, expires_at, source_order_id, customer_email, status, version
       ) VALUES (?, ?, ?, ?, 'CZK', datetime('now', '+1 year'), ?, ?, 'ACTIVE', 0)`
    )
    .bind(
      seed.id,
      seed.tenantId,
      seed.initialMinor,
      seed.initialMinor,
      seed.sourceOrderId,
      `test+${seed.id}@l-code-dynamics.com`
    )
    .run();
  return seed;
}

describe("Migrace 0001_credit_voucher", () => {
  describe("1) Migrace projde a schéma existuje", () => {
    it("vytvoří tabulky vouchers a voucher_transactions", async () => {
      const { results } = await db
        .prepare(
          `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN ('vouchers', 'voucher_transactions')
             ORDER BY name`
        )
        .all<{ name: string }>();

      expect(results.map((r) => r.name)).toEqual([
        "voucher_transactions",
        "vouchers",
      ]);
    });

    it("vytvoří i unikátní indexy, na kterých stojí idempotence", async () => {
      const { results } = await db
        .prepare(
          `SELECT name FROM sqlite_master
             WHERE type = 'index'
               AND name IN ('uq_vouchers_source_order', 'uq_voucher_redemption')
             ORDER BY name`
        )
        .all<{ name: string }>();

      expect(results.map((r) => r.name)).toEqual([
        "uq_voucher_redemption",
        "uq_vouchers_source_order",
      ]);
    });

    it("eviduje aplikované migrace v tabulce d1_migrations", async () => {
      const row = await db
        .prepare(`SELECT name FROM d1_migrations ORDER BY id LIMIT 1`)
        .first<{ name: string }>();

      expect(row?.name).toBe("0001_credit_voucher.sql");
    });
  });

  describe("2) CHECK current_balance_minor >= 0 -- přečerpání do minusu", () => {
    it("odmítne UPDATE, který by srazil zůstatek pod nulu", async () => {
      const v = await seedVoucher(100_00);

      // Čerpání 150 Kč ze 100 Kč. I kdyby aplikační vrstva selhala,
      // DB to nesmí pustit.
      await expect(
        db
          .prepare(
            `UPDATE vouchers SET current_balance_minor = current_balance_minor - ? WHERE id = ?`
          )
          .bind(150_00, v.id)
          .run()
      ).rejects.toThrow();

      const after = await db
        .prepare(`SELECT current_balance_minor AS b FROM vouchers WHERE id = ?`)
        .bind(v.id)
        .first<{ b: number }>();
      expect(after?.b).toBe(100_00);
    });

    it("povolí čerpání přesně na nulu (vyčerpaný poukaz je legální stav)", async () => {
      const v = await seedVoucher(100_00);

      const res = await db
        .prepare(
          `UPDATE vouchers SET current_balance_minor = 0, status = 'DEPLETED' WHERE id = ?`
        )
        .bind(v.id)
        .run();

      expect(res.meta.changes).toBe(1);
    });
  });

  describe("3) CHECK current_balance_minor <= initial_balance_minor -- nafouknutí kreditu", () => {
    it("odmítne UPDATE, který by zvedl zůstatek nad původní hodnotu", async () => {
      const v = await seedVoucher(100_00);

      // Klasický failure mode špatně napsaného refundu: připíše víc, než
      // kolik poukaz kdy měl.
      await expect(
        db
          .prepare(
            `UPDATE vouchers SET current_balance_minor = ? WHERE id = ?`
          )
          .bind(100_01, v.id)
          .run()
      ).rejects.toThrow();
    });
  });

  describe("4) UNIQUE uq_voucher_redemption -- dvojí čerpání toutéž objednávkou", () => {
    it("odmítne druhý REDEEMED se stejnou dvojicí (voucher_id, order_id)", async () => {
      const v = await seedVoucher();
      const orderId = uid("order");

      const first = await db
        .prepare(
          `INSERT INTO voucher_transactions (voucher_id, tenant_id, type, amount_minor, order_id)
             VALUES (?, ?, 'REDEEMED', ?, ?)`
        )
        .bind(v.id, v.tenantId, 10_00, orderId)
        .run();
      expect(first.meta.changes).toBe(1);

      // Dvojí doručení téhož webhooku o čerpání.
      await expect(
        db
          .prepare(
            `INSERT INTO voucher_transactions (voucher_id, tenant_id, type, amount_minor, order_id)
               VALUES (?, ?, 'REDEEMED', ?, ?)`
          )
          .bind(v.id, v.tenantId, 10_00, orderId)
          .run()
      ).rejects.toThrow();
    });

    it("dovolí dva ISSUED s order_id NULL (partial index se jich netýká)", async () => {
      const v = await seedVoucher();

      // Plný unique index by tenhle druhý řádek zabil. Partial
      // (WHERE type = 'REDEEMED' AND order_id IS NOT NULL) ne -- proto tam je.
      for (let i = 0; i < 2; i += 1) {
        const res = await db
          .prepare(
            `INSERT INTO voucher_transactions (voucher_id, tenant_id, type, amount_minor, order_id)
               VALUES (?, ?, 'ISSUED', ?, NULL)`
          )
          .bind(v.id, v.tenantId, 100_00)
          .run();
        expect(res.meta.changes).toBe(1);
      }
    });

    it("dovolí čerpání téhož poukazu JINOU objednávkou", async () => {
      const v = await seedVoucher();

      for (const orderId of [uid("order"), uid("order")]) {
        const res = await db
          .prepare(
            `INSERT INTO voucher_transactions (voucher_id, tenant_id, type, amount_minor, order_id)
               VALUES (?, ?, 'REDEEMED', ?, ?)`
          )
          .bind(v.id, v.tenantId, 5_00, orderId)
          .run();
        expect(res.meta.changes).toBe(1);
      }
    });
  });

  describe("5) UNIQUE uq_vouchers_source_order -- idempotence issuance", () => {
    it("odmítne druhý poukaz vystavený z téže objednávky", async () => {
      const v = await seedVoucher();

      await expect(
        db
          .prepare(
            `INSERT INTO vouchers (
               id, tenant_id, initial_balance_minor, current_balance_minor,
               currency, expires_at, source_order_id, customer_email, status, version
             ) VALUES (?, ?, ?, ?, 'CZK', datetime('now', '+1 year'), ?, ?, 'ACTIVE', 0)`
          )
          .bind(
            uid("NEXUS-DUP"),
            v.tenantId,
            50_00,
            50_00,
            v.sourceOrderId, // stejná objednávka
            "dup@l-code-dynamics.com"
          )
          .run()
      ).rejects.toThrow();
    });

    it("dovolí stejné source_order_id JINÉMU tenantovi (index je per tenant)", async () => {
      const v = await seedVoucher();

      const res = await db
        .prepare(
          `INSERT INTO vouchers (
             id, tenant_id, initial_balance_minor, current_balance_minor,
             currency, expires_at, source_order_id, customer_email, status, version
           ) VALUES (?, ?, ?, ?, 'CZK', datetime('now', '+1 year'), ?, ?, 'ACTIVE', 0)`
        )
        .bind(
          uid("NEXUS-OTHER"),
          uid("tenant-other"),
          50_00,
          50_00,
          v.sourceOrderId,
          "other@l-code-dynamics.com"
        )
        .run();

      expect(res.meta.changes).toBe(1);
    });
  });

  describe("6) CHECK ck_vtx_order_id_presence -- vazba pohybu na objednávku", () => {
    it("odmítne REDEEMED bez order_id", async () => {
      const v = await seedVoucher();

      await expect(
        db
          .prepare(
            `INSERT INTO voucher_transactions (voucher_id, tenant_id, type, amount_minor, order_id)
               VALUES (?, ?, 'REDEEMED', ?, NULL)`
          )
          .bind(v.id, v.tenantId, 10_00)
          .run()
      ).rejects.toThrow();
    });

    it("odmítne ISSUED s vyplněným order_id", async () => {
      const v = await seedVoucher();

      await expect(
        db
          .prepare(
            `INSERT INTO voucher_transactions (voucher_id, tenant_id, type, amount_minor, order_id)
               VALUES (?, ?, 'ISSUED', ?, ?)`
          )
          .bind(v.id, v.tenantId, 100_00, uid("order"))
          .run()
      ).rejects.toThrow();
    });

    it("dovolí CANCELLED s order_id i bez něj (vědomá výjimka, OPEN QUESTION 2)", async () => {
      const v = await seedVoucher();

      const withOrder = await db
        .prepare(
          `INSERT INTO voucher_transactions (voucher_id, tenant_id, type, amount_minor, order_id)
             VALUES (?, ?, 'CANCELLED', ?, ?)`
        )
        .bind(v.id, v.tenantId, 1_00, uid("order"))
        .run();
      expect(withOrder.meta.changes).toBe(1);

      const withoutOrder = await db
        .prepare(
          `INSERT INTO voucher_transactions (voucher_id, tenant_id, type, amount_minor, order_id)
             VALUES (?, ?, 'CANCELLED', ?, NULL)`
        )
        .bind(v.id, v.tenantId, 1_00)
        .run();
      expect(withoutOrder.meta.changes).toBe(1);
    });
  });

  describe("7) Optimistický zámek (§7) -- version ve WHERE", () => {
    it("se špatnou verzí neudělá nic: meta.changes === 0", async () => {
      const v = await seedVoucher(100_00);

      const res = await db
        .prepare(
          `UPDATE vouchers
              SET current_balance_minor = current_balance_minor - ?,
                  version = version + 1
            WHERE id = ? AND version = ?`
        )
        .bind(10_00, v.id, 99) // reálná verze je 0
        .run();

      // POZOR: tohle NENÍ chyba. Žádná výjimka se nehodí -- jen 0 řádků.
      // Volající kód to MUSÍ kontrolovat sám, jinak si myslí, že odečetl.
      expect(res.meta.changes).toBe(0);

      const after = await db
        .prepare(`SELECT current_balance_minor AS b FROM vouchers WHERE id = ?`)
        .bind(v.id)
        .first<{ b: number }>();
      expect(after?.b).toBe(100_00);
    });

    it("se správnou verzí odečte a inkrementuje version: meta.changes === 1", async () => {
      const v = await seedVoucher(100_00);

      const res = await db
        .prepare(
          `UPDATE vouchers
              SET current_balance_minor = current_balance_minor - ?,
                  version = version + 1
            WHERE id = ? AND version = ?`
        )
        .bind(10_00, v.id, 0)
        .run();

      expect(res.meta.changes).toBe(1);

      const after = await db
        .prepare(
          `SELECT current_balance_minor AS b, version AS v FROM vouchers WHERE id = ?`
        )
        .bind(v.id)
        .first<{ b: number; v: number }>();
      expect(after?.b).toBe(90_00);
      expect(after?.v).toBe(1);
    });

    it("druhý souběžný zápis se starou verzí už neprojde (lost update nenastane)", async () => {
      const v = await seedVoucher(100_00);

      // Oba "requesty" si přečetly version = 0.
      const winner = await db
        .prepare(
          `UPDATE vouchers SET current_balance_minor = current_balance_minor - ?, version = version + 1
             WHERE id = ? AND version = 0`
        )
        .bind(30_00, v.id)
        .run();
      const loser = await db
        .prepare(
          `UPDATE vouchers SET current_balance_minor = current_balance_minor - ?, version = version + 1
             WHERE id = ? AND version = 0`
        )
        .bind(30_00, v.id)
        .run();

      expect(winner.meta.changes).toBe(1);
      expect(loser.meta.changes).toBe(0);

      const after = await db
        .prepare(`SELECT current_balance_minor AS b FROM vouchers WHERE id = ?`)
        .bind(v.id)
        .first<{ b: number }>();
      expect(after?.b).toBe(70_00); // odečteno JEDNOU, ne dvakrát
    });
  });

  // =========================================================================
  // 8) KRITICKÝ NÁLEZ -- DOKUMENTUJÍCÍ TEST, NE SELHÁVAJÍCÍ.
  //
  // D1 `batch()` je autocommit transakce, která se rollbackuje POUZE při SQL
  // CHYBĚ. Optimistický zámek ale při konfliktu ŽÁDNOU chybu nehází -- vrátí
  // `meta.changes === 0`. Pro batch je to naprosto validní statement.
  //
  // DŮSLEDEK: batch([UPDATE ... WHERE version = <stará>, INSERT REDEEMED])
  // se NEROLLBACKNE. UPDATE neudělá nic, INSERT PROJDE. Vznikne transakční
  // záznam o čerpání BEZ ODPOVÍDAJÍCÍHO ODEČTU ZE ZŮSTATKU -- tj. rozpad
  // reconciliačního invariantu a kredit, který zákazník utratil dvakrát.
  //
  // PROTO `redeem()` NESMÍ spoléhat na batch() jako na transakci. Musí:
  //   1) provést UPDATE samostatně,
  //   2) OVĚŘIT meta.changes === 1,
  //   3) teprve pak zapsat INSERT.
  // (Sekundární pojistka pro dvojí webhook je uq_voucher_redemption -- ta ale
  //  konflikt VERZE nechytá, jen opakování téže objednávky.)
  //
  // Tenhle test je DŮKAZ toho chování. Zezelená právě tehdy, když díra
  // existuje. Kdyby jednou zčervenal, znamená to, že se D1 sémantika změnila
  // -- a je potřeba přehodnotit CreditVoucherRepository, ne "opravit" test.
  // =========================================================================
  describe("8) D1 batch() NENÍ ochrana proti konfliktu optimistického zámku", () => {
    it("při 0-changes UPDATE se batch NEROLLBACKNE a INSERT projde bez odečtu", async () => {
      const v = await seedVoucher(100_00);
      const orderId = uid("order-batch");

      const [updateRes, insertRes] = await db.batch([
        // Konflikt verze: reálná je 0, my pošleme 99. Nula změn, ŽÁDNÁ chyba.
        db
          .prepare(
            `UPDATE vouchers
                SET current_balance_minor = current_balance_minor - ?,
                    version = version + 1
              WHERE id = ? AND version = ?`
          )
          .bind(40_00, v.id, 99),
        // Zápis o čerpání, který na tom UPDATE logicky závisí.
        db
          .prepare(
            `INSERT INTO voucher_transactions (voucher_id, tenant_id, type, amount_minor, order_id)
               VALUES (?, ?, 'REDEEMED', ?, ?)`
          )
          .bind(v.id, v.tenantId, 40_00, orderId),
      ]);

      // Ani jeden statement nehodil chybu -- batch se považuje za úspěšný.
      expect(updateRes?.success).toBe(true);
      expect(insertRes?.success).toBe(true);

      // Zůstatek se NEZMĚNIL.
      expect(updateRes?.meta.changes).toBe(0);
      const voucherAfter = await db
        .prepare(`SELECT current_balance_minor AS b, version AS v FROM vouchers WHERE id = ?`)
        .bind(v.id)
        .first<{ b: number; v: number }>();
      expect(voucherAfter?.b).toBe(100_00);
      expect(voucherAfter?.v).toBe(0);

      // ALE transakční záznam o čerpání TAM JE. Tohle je ta díra.
      const tx = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM voucher_transactions
             WHERE voucher_id = ? AND order_id = ? AND type = 'REDEEMED'`
        )
        .bind(v.id, orderId)
        .first<{ c: number }>();
      expect(tx?.c).toBe(1);

      // Shrnutí nálezu jedním assertem: zapsáno čerpání 40 Kč, odečteno 0 Kč.
      expect({
        odectenoMinor: 100_00 - (voucherAfter?.b ?? 0),
        zapsanychCerpani: tx?.c,
      }).toEqual({ odectenoMinor: 0, zapsanychCerpani: 1 });
    });

    it("naproti tomu SQL CHYBA v batchi rollbackne i statementy před ní", async () => {
      const v = await seedVoucher(100_00);
      const orderId = uid("order-batch-err");

      // Kontrastní případ: druhý statement poruší CHECK -> celý batch spadne.
      await expect(
        db.batch([
          db
            .prepare(
              `INSERT INTO voucher_transactions (voucher_id, tenant_id, type, amount_minor, order_id)
                 VALUES (?, ?, 'REDEEMED', ?, ?)`
            )
            .bind(v.id, v.tenantId, 10_00, orderId),
          db
            .prepare(
              // Přečerpání -> ck_vouchers_balance_non_negative -> SQL chyba.
              `UPDATE vouchers SET current_balance_minor = current_balance_minor - ? WHERE id = ?`
            )
            .bind(500_00, v.id),
        ])
      ).rejects.toThrow();

      // Rollback proběhl: první INSERT v DB NENÍ.
      const tx = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM voucher_transactions WHERE order_id = ?`
        )
        .bind(orderId)
        .first<{ c: number }>();
      expect(tx?.c).toBe(0);
    });
  });
});

// Sanity: setup.ts musel migrace aplikovat dřív, než se sem dostaneme.
beforeAll(() => {
  if (!db) {
    throw new Error(
      "env.DB není k dispozici -- chybí d1Databases binding ve vitest.workers.config.ts"
    );
  }
});
