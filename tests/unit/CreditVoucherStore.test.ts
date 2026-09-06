// InMemoryCreditVoucherStore -- domains/voucher/CreditVoucherStore.ts
// (docs/design-proposals/Digital-Voucher.md §3/§4/§7, ROZHODNUTO Lucky 2026-09-06).
//
// Co tyhle testy hlídají -- CHOVÁNÍ kontraktu, ne implementaci:
//   - §4 idempotentní emise na `(tenantId, sourceOrderId)` (uq_vouchers_source_order).
//   - §7 optimistický zámek: stará `expectedVersion` -> VERSION_CONFLICT.
//   - `uq_voucher_redemption (voucher_id, order_id)`: dvojí webhook odečte
//     kredit PRÁVĚ JEDNOU a druhý pokus je ÚSPĚCH (`ALREADY_REDEEMED`).
//   - `DEPLETED -> ACTIVE` refundací (DEPLETED není terminální stav).
//   - RECONCILIATION CONTRACT (CreditVoucher.ts): `currentBalance ===
//     initialBalance - SUM(REDEEMED|EXPIRED|CANCELLED) + SUM(REFUNDED)`.
//
// ============================================================================
// CO SE TADY OVĚŘIT NEDÁ -- patří do `tests/workers/`
// ============================================================================
// In-memory store je single-threaded JS: skutečný SOUBĚH neexistuje. Proti
// reálné D1 (Miniflare / `wrangler dev`) se musí ověřit:
//   - Že `UPDATE ... WHERE version = ?` opravdu vrátí `meta.changes === 0`
//     při paralelním čerpání dvou požadavků, a že se transakce NEZAPÍŠE.
//   - Že `batch()` NEROLLBACKUJE nematchnutý UPDATE (hlavička CreditVoucherStore.ts,
//     bod 1) -- proto UPDATE a INSERT jako dva oddělené round-tripy.
//   - Že partial unique index `uq_voucher_redemption` skutečně existuje
//     a shodí druhý souběžný INSERT, ne jen aplikační Map.
// Tyhle testy tedy ověřují KONTRAKT, který D1 implementace musí splnit --
// ne to, že ho D1 splňuje. To je jiná vrstva a jiný běh.

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
    InMemoryCreditVoucherStore,
    type IssueCreditVoucherInput,
} from '../../domains/voucher/CreditVoucherStore.js';
import { TenantIsolationViolation, type TenantContext } from '../../core/tenant/types.js';
import type { CreditVoucherTransaction } from '../../core/canonical/entities/CreditVoucher.js';
import type { Money } from '../../core/canonical/entities/base.js';

const TENANT = 'ten_1';
const ctx: TenantContext = { tenantId: TENANT, platform: 'shoptet' };
const otherCtx: TenantContext = { tenantId: 'ten_2', platform: 'shoptet' };

const czk = (amount: string): Money => ({ amount: new Decimal(amount), currency: 'CZK' });

const ISSUED_AT = '2026-09-06T10:00:00Z';
const NOW = '2026-09-06T12:00:00Z';
const EXPIRES = '2027-09-06T10:00:00Z';

const issueInput = (over: Partial<IssueCreditVoucherInput> = {}): IssueCreditVoucherInput => ({
    id: 'NEXUS-A1B2-C3D4-2026',
    tenantId: TENANT,
    initialBalance: czk('1500'),
    expiresAt: EXPIRES,
    sourceOrderId: 'ord_source_1',
    customerEmail: 'zakaznik@example.com',
    issuedAt: ISSUED_AT,
    ...over,
});

/**
 * Reconciliační invariant z CreditVoucher.ts. Počítá se z transakční historie,
 * ne z uloženého zůstatku -- kdyby se počítal z něj, netestoval by nic.
 */
function reconcile(transactions: readonly CreditVoucherTransaction[]): Decimal {
    return transactions.reduce((acc, tx) => {
        switch (tx.type) {
            case 'ISSUED':
            case 'REFUNDED':
                return acc.plus(tx.amount.amount);
            case 'REDEEMED':
            case 'EXPIRED':
            case 'CANCELLED':
                return acc.minus(tx.amount.amount);
            default:
                return acc;
        }
    }, new Decimal(0));
}

describe('InMemoryCreditVoucherStore -- happy path issue -> findByCode -> redeem -> listTransactions', () => {
    it('emise vystaví plný ACTIVE poukaz s version 0 a ISSUED transakcí', async () => {
        const store = new InMemoryCreditVoucherStore();

        const result = await store.issue(ctx, issueInput());

        expect(result.alreadyExisted).toBe(false);
        expect(result.voucher.currentBalance.amount.toString()).toBe('1500');
        expect(result.voucher.initialBalance.amount.toString()).toBe('1500');
        expect(result.voucher.status).toBe('ACTIVE');
        expect(result.voucher.version).toBe(0);
        expect(result.transaction?.type).toBe('ISSUED');
        // ISSUED není spotřebitelská objednávka -- `orderId` tam nepatří.
        expect(result.transaction?.orderId).toBeUndefined();
    });

    it('findByCode vrátí vystavený poukaz podle kódu (kód JE id, §4)', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        const found = await store.findByCode(TENANT, voucher.id);

        expect(found?.id).toBe('NEXUS-A1B2-C3D4-2026');
        expect(found?.customerEmail).toBe('zakaznik@example.com');
    });

    it('neexistující kód -> undefined, ne výjimka (validační endpoint dostane čistou odpověď)', async () => {
        const store = new InMemoryCreditVoucherStore();

        expect(await store.findByCode(TENANT, 'NEXUS-XXXX-XXXX-9999')).toBeUndefined();
    });

    it('čerpání 800 z 1500 -> zůstatek 700, version 1, poukaz zůstává ACTIVE', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        const result = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('800'),
            expectedVersion: 0,
            now: NOW,
        });

        expect(result.outcome).toBe('REDEEMED');
        if (result.outcome !== 'REDEEMED') return;
        expect(result.newBalance.amount.toString()).toBe('700');
        expect(result.newVersion).toBe(1);

        const fresh = await store.findByCode(TENANT, voucher.id);
        expect(fresh?.status).toBe('ACTIVE');
        expect(fresh?.currentBalance.amount.toString()).toBe('700');
    });

    it('vyčerpání do nuly překlopí stav na DEPLETED TÝMŽ zápisem (invariant 4)', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('1500'),
            expectedVersion: 0,
            now: NOW,
        });

        const fresh = await store.findByCode(TENANT, voucher.id);
        expect(fresh?.currentBalance.amount.isZero()).toBe(true);
        expect(fresh?.status).toBe('DEPLETED');
    });

    it('listTransactions vrátí ISSUED i REDEEMED v pořadí vzniku', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('800'),
            expectedVersion: 0,
            now: NOW,
        });

        const txs = await store.listTransactions(TENANT, voucher.id);

        expect(txs.map((t) => t.type)).toEqual(['ISSUED', 'REDEEMED']);
        expect(txs[1]?.orderId).toBe('ord_cart_1');
        expect(txs[1]?.amount.amount.toString()).toBe('800');
    });

    it('postupné čerpání ve dvou objednávkách: 1500 -> 700 -> 200', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('800'),
            expectedVersion: 0,
            now: NOW,
        });
        const second = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_2',
            amount: czk('500'),
            expectedVersion: 1,
            now: NOW,
        });

        expect(second.outcome).toBe('REDEEMED');
        if (second.outcome !== 'REDEEMED') return;
        expect(second.newBalance.amount.toString()).toBe('200');
        expect(second.newVersion).toBe(2);
    });
});

describe('InMemoryCreditVoucherStore -- idempotence čerpání (uq_voucher_redemption)', () => {
    it('KRITICKÉ: stejné (voucherId, orderId) dvakrát -> ALREADY_REDEEMED a kredit odečten JEN JEDNOU', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());
        const params = {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('800'),
            expectedVersion: 0,
            now: NOW,
        };

        const first = await store.redeem(ctx, params);
        const second = await store.redeem(ctx, params);

        expect(first.outcome).toBe('REDEEMED');
        expect(second.outcome).toBe('ALREADY_REDEEMED');

        const fresh = await store.findByCode(TENANT, voucher.id);
        // 1500 - 800 = 700. Kdyby se odečetlo dvakrát, bylo by tu 0 nebo -100.
        expect(fresh?.currentBalance.amount.toString()).toBe('700');
        expect(fresh?.version).toBe(1);
    });

    it('druhý pokus vrátí ID PŮVODNÍ transakce a NEZALOŽÍ druhou (append-only historie zůstane čistá)', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());
        const params = {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('800'),
            expectedVersion: 0,
            now: NOW,
        };

        const first = await store.redeem(ctx, params);
        const second = await store.redeem(ctx, params);

        if (first.outcome !== 'REDEEMED' || second.outcome !== 'ALREADY_REDEEMED') {
            throw new Error('nečekané outcome');
        }
        expect(second.transactionId).toBe(first.transactionId);

        const redemptions = (await store.listTransactions(TENANT, voucher.id)).filter(
            (t) => t.type === 'REDEEMED'
        );
        expect(redemptions).toHaveLength(1);
    });

    it('idempotence má PŘEDNOST před version konfliktem -- dvojí webhook nesmí skončit jako retryovatelný souběh', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());
        const params = {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('800'),
            expectedVersion: 0,
            now: NOW,
        };

        await store.redeem(ctx, params);
        // Tentýž (zastaralý) expectedVersion 0 -- verze je už 1.
        const replay = await store.redeem(ctx, params);

        // ALREADY_REDEEMED = pro volajícího ÚSPĚCH. VERSION_CONFLICT by ho
        // poslal retryovat a při retry s čerstvou verzí by odečetl podruhé.
        expect(replay.outcome).toBe('ALREADY_REDEEMED');
    });

    it('jiná objednávka z téhož poukazu idempotencí blokovaná NENÍ', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('800'),
            expectedVersion: 0,
            now: NOW,
        });
        const other = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_2',
            amount: czk('100'),
            expectedVersion: 1,
            now: NOW,
        });

        expect(other.outcome).toBe('REDEEMED');
    });
});

describe('InMemoryCreditVoucherStore -- optimistický zámek (§7)', () => {
    it('KRITICKÉ: redeem se STAROU expectedVersion -> VERSION_CONFLICT s aktuální verzí', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        // Dva "paralelní" košíky si přečetly stejný snapshot (version 0).
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('800'),
            expectedVersion: 0,
            now: NOW,
        });
        const stale = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_2',
            amount: czk('300'),
            expectedVersion: 0,
            now: NOW,
        });

        expect(stale.outcome).toBe('VERSION_CONFLICT');
        if (stale.outcome !== 'VERSION_CONFLICT') return;
        expect(stale.actualVersion).toBe(1);
    });

    it('VERSION_CONFLICT NESMÍ odečíst kredit ani založit transakci', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('800'),
            expectedVersion: 0,
            now: NOW,
        });

        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_2',
            amount: czk('300'),
            expectedVersion: 0,
            now: NOW,
        });

        const fresh = await store.findByCode(TENANT, voucher.id);
        expect(fresh?.currentBalance.amount.toString()).toBe('700');
        expect((await store.listTransactions(TENANT, voucher.id)).length).toBe(2); // ISSUED + 1x REDEEMED
    });

    it('retry s ČERSTVOU verzí projde -- to je ta cesta, kterou má volající po konfliktu jít', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('800'),
            expectedVersion: 0,
            now: NOW,
        });

        const conflict = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_2',
            amount: czk('300'),
            expectedVersion: 0,
            now: NOW,
        });
        if (conflict.outcome !== 'VERSION_CONFLICT') throw new Error('čekal se konflikt');

        const retry = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_2',
            amount: czk('300'),
            expectedVersion: conflict.actualVersion,
            now: NOW,
        });

        expect(retry.outcome).toBe('REDEEMED');
        if (retry.outcome !== 'REDEEMED') return;
        expect(retry.newBalance.amount.toString()).toBe('400');
    });

    it('verze se vyhodnocuje PŘED podmínkami platnosti -- na zastaralém snapshotu by byl jiný důvod odvozen ze špatných dat', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('1500'),
            expectedVersion: 0,
            now: NOW,
        });

        // Poukaz je teď DEPLETED I má starou verzi. Musí vyhrát VERSION_CONFLICT.
        const stale = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_2',
            amount: czk('10'),
            expectedVersion: 0,
            now: NOW,
        });

        expect(stale.outcome).toBe('VERSION_CONFLICT');
    });
});

describe('InMemoryCreditVoucherStore -- business zamítnutí čerpání', () => {
    it('čerpání víc, než je zůstatek -> INSUFFICIENT_BALANCE, ne výjimka a ne záporný zůstatek', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput({ initialBalance: czk('500') }));

        const result = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('500.01'),
            expectedVersion: 0,
            now: NOW,
        });

        expect(result.outcome).toBe('INSUFFICIENT_BALANCE');
        if (result.outcome !== 'INSUFFICIENT_BALANCE') return;
        expect(result.currentBalance.amount.toString()).toBe('500');

        const fresh = await store.findByCode(TENANT, voucher.id);
        expect(fresh?.currentBalance.amount.toString()).toBe('500');
        expect(fresh?.version).toBe(0);
    });

    it('čerpání PŘESNĚ na zůstatek projde -- hranice není "o haléř míň"', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput({ initialBalance: czk('500') }));

        const result = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('500'),
            expectedVersion: 0,
            now: NOW,
        });

        expect(result.outcome).toBe('REDEEMED');
    });

    it('expirovaný poukaz -> NOT_REDEEMABLE / EXPIRED (podmínka `expires_at > NOW()`)', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput({ expiresAt: '2026-01-01T00:00:00Z' }));

        const result = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('100'),
            expectedVersion: 0,
            now: NOW,
        });

        expect(result.outcome).toBe('NOT_REDEEMABLE');
        if (result.outcome !== 'NOT_REDEEMABLE') return;
        expect(result.reason).toBe('EXPIRED');
    });

    it('expirace přesně v `now` -> zamítnuto (ostrá nerovnost, ne >=)', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput({ expiresAt: NOW }));

        const result = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('100'),
            expectedVersion: 0,
            now: NOW,
        });

        expect(result.outcome).toBe('NOT_REDEEMABLE');
    });

    it('vyčerpaný poukaz -> NOT_REDEEMABLE / DEPLETED při dalším čerpání', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput({ initialBalance: czk('100') }));
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('100'),
            expectedVersion: 0,
            now: NOW,
        });

        const result = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_2',
            amount: czk('10'),
            expectedVersion: 1,
            now: NOW,
        });

        expect(result.outcome).toBe('NOT_REDEEMABLE');
        if (result.outcome !== 'NOT_REDEEMABLE') return;
        expect(result.reason).toBe('DEPLETED');
    });

    it('nulová a záporná částka čerpání je programátorská chyba -> výjimka, ne outcome', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());
        const base = {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            expectedVersion: 0,
            now: NOW,
        };

        await expect(store.redeem(ctx, { ...base, amount: czk('0') })).rejects.toThrow();
        await expect(store.redeem(ctx, { ...base, amount: czk('-50') })).rejects.toThrow();
    });

    it('čerpání v jiné měně než poukaz -> výjimka (invariant 2: jedna měna po celý život)', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        await expect(
            store.redeem(ctx, {
                tenantId: TENANT,
                voucherId: voucher.id,
                orderId: 'ord_cart_1',
                amount: { amount: new Decimal('100'), currency: 'EUR' },
                expectedVersion: 0,
                now: NOW,
            })
        ).rejects.toThrow(/[Cc]urrency/);
    });
});

describe('InMemoryCreditVoucherStore -- idempotentní emise (§4, uq_vouchers_source_order)', () => {
    it('KRITICKÉ: dvě emise ze stejné sourceOrderId -> jeden poukaz, alreadyExisted:true', async () => {
        const store = new InMemoryCreditVoucherStore();

        const first = await store.issue(ctx, issueInput({ id: 'NEXUS-AAAA-BBBB-2026' }));
        // Druhé doručení téhož webhooku -- generátor mezitím vyrobil jiný kód.
        const second = await store.issue(ctx, issueInput({ id: 'NEXUS-CCCC-DDDD-2026' }));

        expect(first.alreadyExisted).toBe(false);
        expect(second.alreadyExisted).toBe(true);
        // Vrací se PŮVODNÍ poukaz, ne nově vygenerovaný kód.
        expect(second.voucher.id).toBe('NEXUS-AAAA-BBBB-2026');
        // Druhý kód nesmí v úložišti existovat vůbec.
        expect(await store.findByCode(TENANT, 'NEXUS-CCCC-DDDD-2026')).toBeUndefined();
    });

    it('opakovaná emise NEZALOŽÍ druhou ISSUED transakci -- jinak by reconciliace zdvojila kredit', async () => {
        const store = new InMemoryCreditVoucherStore();
        const first = await store.issue(ctx, issueInput({ id: 'NEXUS-AAAA-BBBB-2026' }));
        const second = await store.issue(ctx, issueInput({ id: 'NEXUS-CCCC-DDDD-2026' }));

        expect(second.transaction).toBeUndefined();

        const txs = await store.listTransactions(TENANT, first.voucher.id);
        expect(txs.filter((t) => t.type === 'ISSUED')).toHaveLength(1);
    });

    it('jiná sourceOrderId -> vznikne skutečně druhý poukaz', async () => {
        const store = new InMemoryCreditVoucherStore();

        await store.issue(ctx, issueInput({ id: 'NEXUS-AAAA-BBBB-2026' }));
        const second = await store.issue(
            ctx,
            issueInput({ id: 'NEXUS-CCCC-DDDD-2026', sourceOrderId: 'ord_source_2' })
        );

        expect(second.alreadyExisted).toBe(false);
        expect(await store.findByCode(TENANT, 'NEXUS-CCCC-DDDD-2026')).toBeDefined();
    });

    it('kolize KÓDU (jiná sourceOrderId, stejné id) je incident -> výjimka, ne tichá idempotence', async () => {
        const store = new InMemoryCreditVoucherStore();
        await store.issue(ctx, issueInput());

        await expect(
            store.issue(ctx, issueInput({ sourceOrderId: 'ord_source_2' }))
        ).rejects.toThrow(/already exists/);
    });

    it('nulová nominální hodnota poukazu -> výjimka (poukaz na nic není poukaz)', async () => {
        const store = new InMemoryCreditVoucherStore();

        await expect(store.issue(ctx, issueInput({ initialBalance: czk('0') }))).rejects.toThrow();
    });
});

describe('InMemoryCreditVoucherStore -- refundace vrací DEPLETED zpět na ACTIVE', () => {
    /** Vystaví poukaz a vyčerpá ho celý -- výchozí stav pro refundační testy. */
    async function depleted(initial = '1000') {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput({ initialBalance: czk(initial) }));
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk(initial),
            expectedVersion: 0,
            now: NOW,
        });
        return { store, voucherId: voucher.id };
    }

    it('KRITICKÉ: refundace vyčerpaného poukazu ho překlopí DEPLETED -> ACTIVE', async () => {
        const { store, voucherId } = await depleted('1000');

        const result = await store.refund(ctx, {
            tenantId: TENANT,
            voucherId,
            orderId: 'ord_cart_1',
            amount: czk('1000'),
            expectedVersion: 1,
            now: '2026-09-07T09:00:00Z',
        });

        expect(result.outcome).toBe('REFUNDED');
        if (result.outcome !== 'REFUNDED') return;
        expect(result.reactivated).toBe(true);
        expect(result.newBalance.amount.toString()).toBe('1000');

        const fresh = await store.findByCode(TENANT, voucherId);
        expect(fresh?.status).toBe('ACTIVE');
    });

    it('reaktivovaný poukaz jde znovu čerpat -- refundace není jen kosmetika stavu', async () => {
        const { store, voucherId } = await depleted('1000');
        const refund = await store.refund(ctx, {
            tenantId: TENANT,
            voucherId,
            orderId: 'ord_cart_1',
            amount: czk('1000'),
            expectedVersion: 1,
            now: '2026-09-07T09:00:00Z',
        });
        if (refund.outcome !== 'REFUNDED') throw new Error('refundace selhala');

        const again = await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId,
            orderId: 'ord_cart_9',
            amount: czk('250'),
            expectedVersion: refund.newVersion,
            now: '2026-09-07T10:00:00Z',
        });

        expect(again.outcome).toBe('REDEEMED');
        if (again.outcome !== 'REDEEMED') return;
        expect(again.newBalance.amount.toString()).toBe('750');
    });

    it('částečná refundace ACTIVE poukazu stav nemění (reactivated:false)', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput({ initialBalance: czk('1000') }));
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('400'),
            expectedVersion: 0,
            now: NOW,
        });

        const result = await store.refund(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_cart_1',
            amount: czk('400'),
            expectedVersion: 1,
            now: NOW,
        });

        expect(result.outcome).toBe('REFUNDED');
        if (result.outcome !== 'REFUNDED') return;
        expect(result.reactivated).toBe(false);
        expect(result.newBalance.amount.toString()).toBe('1000');
    });

    it('refundace nad initialBalance -> EXCEEDS_INITIAL_BALANCE (kredit z ničeho neexistuje)', async () => {
        const { store, voucherId } = await depleted('1000');

        const result = await store.refund(ctx, {
            tenantId: TENANT,
            voucherId,
            orderId: 'ord_cart_1',
            amount: czk('1000.01'),
            expectedVersion: 1,
            now: NOW,
        });

        expect(result.outcome).toBe('EXCEEDS_INITIAL_BALANCE');
        const fresh = await store.findByCode(TENANT, voucherId);
        expect(fresh?.currentBalance.amount.isZero()).toBe(true);
    });

    it('refundace objednávky, ze které se nikdy nečerpalo -> NOTHING_TO_REFUND', async () => {
        const { store, voucherId } = await depleted('1000');

        const result = await store.refund(ctx, {
            tenantId: TENANT,
            voucherId,
            orderId: 'ord_nikdy_neexistovala',
            amount: czk('100'),
            expectedVersion: 1,
            now: NOW,
        });

        expect(result.outcome).toBe('NOTHING_TO_REFUND');
    });

    it('refundace se starou expectedVersion -> VERSION_CONFLICT', async () => {
        const { store, voucherId } = await depleted('1000');

        const result = await store.refund(ctx, {
            tenantId: TENANT,
            voucherId,
            orderId: 'ord_cart_1',
            amount: czk('100'),
            expectedVersion: 0,
            now: NOW,
        });

        expect(result.outcome).toBe('VERSION_CONFLICT');
    });

    it('refundace zakládá REFUNDED protipohyb, REDEEMED záznam se NEMAŽE (append-only)', async () => {
        const { store, voucherId } = await depleted('1000');
        await store.refund(ctx, {
            tenantId: TENANT,
            voucherId,
            orderId: 'ord_cart_1',
            amount: czk('1000'),
            expectedVersion: 1,
            now: NOW,
        });

        const txs = await store.listTransactions(TENANT, voucherId);
        expect(txs.map((t) => t.type)).toEqual(['ISSUED', 'REDEEMED', 'REFUNDED']);
        // Protipohyb je kladná částka, směr nese `type` (invariant 1).
        expect(txs[2]?.amount.amount.toString()).toBe('1000');
        expect(txs[2]?.orderId).toBe('ord_cart_1');
    });
});

describe('InMemoryCreditVoucherStore -- reconciliační invariant', () => {
    it('po emisi sedí currentBalance na součet transakcí', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        const txs = await store.listTransactions(TENANT, voucher.id);
        expect(reconcile(txs).toString()).toBe(voucher.currentBalance.amount.toString());
    });

    it('KRITICKÉ: po sérii čerpání a refundací sedí currentBalance = initial - SUM(REDEEMED) + SUM(REFUNDED)', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput({ initialBalance: czk('2000') }));
        const id = voucher.id;

        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: id,
            orderId: 'ord_1',
            amount: czk('750.50'),
            expectedVersion: 0,
            now: NOW,
        });
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: id,
            orderId: 'ord_2',
            amount: czk('249.50'),
            expectedVersion: 1,
            now: NOW,
        });
        // Zamítnuté pokusy nesmí invariant rozhodit.
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: id,
            orderId: 'ord_3',
            amount: czk('5000'),
            expectedVersion: 2,
            now: NOW,
        });
        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: id,
            orderId: 'ord_1',
            amount: czk('750.50'),
            expectedVersion: 2,
            now: NOW,
        }); // ALREADY_REDEEMED
        await store.refund(ctx, {
            tenantId: TENANT,
            voucherId: id,
            orderId: 'ord_1',
            amount: czk('750.50'),
            expectedVersion: 2,
            now: NOW,
        });

        const fresh = await store.findByCode(TENANT, id);
        const txs = await store.listTransactions(TENANT, id);

        expect(fresh?.currentBalance.amount.toString()).toBe('1750.5');
        expect(reconcile(txs).toString()).toBe(fresh!.currentBalance.amount.toString());
    });

    it('invariant drží i na haléřích a delší sérii drobných čerpání (žádná float eroze)', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput({ initialBalance: czk('10') }));
        const id = voucher.id;

        for (let i = 0; i < 30; i += 1) {
            const result = await store.redeem(ctx, {
                tenantId: TENANT,
                voucherId: id,
                orderId: `ord_${i}`,
                amount: czk('0.1'),
                expectedVersion: i,
                now: NOW,
            });
            expect(result.outcome).toBe('REDEEMED');
        }

        const fresh = await store.findByCode(TENANT, id);
        expect(fresh?.currentBalance.amount.toString()).toBe('7');
        expect(reconcile(await store.listTransactions(TENANT, id)).toString()).toBe('7');
    });

    it('zamítnutá operace nezakládá žádnou transakci -- historie nesmí obsahovat "co se nestalo"', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput({ initialBalance: czk('100') }));

        await store.redeem(ctx, {
            tenantId: TENANT,
            voucherId: voucher.id,
            orderId: 'ord_1',
            amount: czk('999'),
            expectedVersion: 0,
            now: NOW,
        });

        expect(await store.listTransactions(TENANT, voucher.id)).toHaveLength(1); // jen ISSUED
    });
});

describe('InMemoryCreditVoucherStore -- tenant izolace (kód je platidlo)', () => {
    it('findByCode cizího tenanta vrátí undefined, ne cizí poukaz a ne jinou chybu (enumerace)', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        expect(await store.findByCode('ten_2', voucher.id)).toBeUndefined();
    });

    it('redeem pod cizím tenant kontextem je bezpečnostní incident -> TenantIsolationViolation', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        await expect(
            store.redeem(otherCtx, {
                tenantId: 'ten_2',
                voucherId: voucher.id,
                amount: czk('100'),
                orderId: 'ord_cart_1',
                expectedVersion: 0,
                now: NOW,
            })
        ).rejects.toBeInstanceOf(TenantIsolationViolation);
    });

    it('volající si nesmí sám určit tenanta -- params.tenantId musí odpovídat kontextu', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        await expect(
            store.redeem(otherCtx, {
                tenantId: TENANT, // podvržený "správný" tenant proti cizímu kontextu
                voucherId: voucher.id,
                orderId: 'ord_cart_1',
                amount: czk('100'),
                expectedVersion: 0,
                now: NOW,
            })
        ).rejects.toBeInstanceOf(TenantIsolationViolation);
    });

    it('listTransactions cizího tenanta vrátí prázdno, ne cizí finanční historii', async () => {
        const store = new InMemoryCreditVoucherStore();
        const { voucher } = await store.issue(ctx, issueInput());

        expect(await store.listTransactions('ten_2', voucher.id)).toHaveLength(0);
    });

    it('mutace nad neexistujícím poukazem je chyba volajícího -> výjimka, ne outcome', async () => {
        const store = new InMemoryCreditVoucherStore();

        await expect(
            store.redeem(ctx, {
                tenantId: TENANT,
                voucherId: 'NEXUS-NENI-TAKY-0000',
                orderId: 'ord_cart_1',
                amount: czk('100'),
                expectedVersion: 0,
                now: NOW,
            })
        ).rejects.toThrow(/not found/);
    });
});
