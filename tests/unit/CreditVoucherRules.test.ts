// Fáze A voucher domény -- domains/voucher/{CreditVoucherRedemptionRule,
// CreditVoucherValidityRule,CreditVoucherLifecycleRule}.ts
// (docs/design-proposals/Digital-Voucher.md §6/§7/§8, ROZHODNUTO Lucky 2026-09-06).
//
// Co tyhle testy hlídají:
//   - §6 min(currentBalance, cartTotal) včetně hranice zůstatek == košík.
//   - §8 tři podmínky platnosti a jejich pořadí v důvodech.
//   - §7 stavový diagram, zejména NEterminální `DEPLETED` (refundace).
//   - DETERMINISMUS (Rule.ts TVRDÝ POŽADAVEK): stejný vstup = stejný výsledek,
//     `now` je vstup a Rules nesmí sáhnout na hodiny.
//   - Peníze jako Decimal, nikdy float (base.ts).
//
// Co tyhle testy VĚDOMĚ NEHLÍDAJÍ: atomicitu čerpání. Autorita je SQL WHERE
// s optimistickým zámkem (§7) a ta se v node prostředí ověřit nedá --
// patří do `tests/workers/` proti reálné D1.

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
    CreditVoucherRedemptionRule,
    type CreditVoucherRedemptionRuleInput,
} from '../../domains/voucher/CreditVoucherRedemptionRule.js';
import {
    CreditVoucherValidityRule,
    type CreditVoucherValidityRuleInput,
} from '../../domains/voucher/CreditVoucherValidityRule.js';
import {
    CreditVoucherLifecycleRule,
    isCreditVoucherTerminal,
} from '../../domains/voucher/CreditVoucherLifecycleRule.js';
import type { CreditVoucherLifecycleState } from '../../core/canonical/entities/CreditVoucher.js';
import type { Money } from '../../core/canonical/entities/base.js';

const ctx = { tenantId: 'ten_1', ruleId: 'test', ruleVersion: '1' };

/** Peníze se do testu píšou jako string -- float by rozbil přesnost dřív než Rule. */
const czk = (amount: string): Money => ({ amount: new Decimal(amount), currency: 'CZK' });
const eur = (amount: string): Money => ({ amount: new Decimal(amount), currency: 'EUR' });

const NOW = '2026-09-06T12:00:00Z';
const FUTURE = '2027-09-06T12:00:00Z';
const PAST = '2025-09-06T12:00:00Z';

const redemptionInput = (
    over: Partial<CreditVoucherRedemptionRuleInput> = {}
): CreditVoucherRedemptionRuleInput => ({
    currentBalance: czk('1500'),
    status: 'ACTIVE',
    expiresAt: FUTURE,
    now: NOW,
    cartTotal: czk('800'),
    ...over,
});

describe('CreditVoucherRedemptionRule -- §6 min(currentBalance, cartTotal)', () => {
    const rule = new CreditVoucherRedemptionRule(ctx);

    it('košík 800 z poukazu 1500 -> čerpá 800, zbývá 700, poukaz zůstává ACTIVE', () => {
        const result = rule.evaluate(redemptionInput());

        expect(result.allowed).toBe(true);
        expect(result.redeemableAmount.amount.toString()).toBe('800');
        expect(result.remainingBalance.amount.toString()).toBe('700');
        // Částečné čerpání NENÍ stavový přechod (§7) -- stav se nesmí hnout.
        expect(result.resultingStatus).toBe('ACTIVE');
    });

    it('košík 3000 z poukazu 1500 -> čerpá celý zůstatek 1500, zbývá 0, poukaz DEPLETED', () => {
        const result = rule.evaluate(redemptionInput({ cartTotal: czk('3000') }));

        expect(result.allowed).toBe(true);
        expect(result.redeemableAmount.amount.toString()).toBe('1500');
        expect(result.remainingBalance.amount.isZero()).toBe(true);
        // Invariant 4: zůstatek 0 <=> DEPLETED, nastavuje TÝŽ update.
        expect(result.resultingStatus).toBe('DEPLETED');
    });

    it('košík přesně roven zůstatku -> zbývá 0 a DEPLETED (hranice, ne "skoro vyčerpáno")', () => {
        const result = rule.evaluate({
            ...redemptionInput(),
            currentBalance: czk('1234.56'),
            cartTotal: czk('1234.56'),
        });

        expect(result.allowed).toBe(true);
        expect(result.redeemableAmount.amount.toString()).toBe('1234.56');
        expect(result.remainingBalance.amount.isZero()).toBe(true);
        expect(result.resultingStatus).toBe('DEPLETED');
    });

    it('čerpatelná částka i zbytek nesou měnu poukazu, ne měnu vstupu volajícího', () => {
        const result = rule.evaluate(redemptionInput());
        expect(result.redeemableAmount.currency).toBe('CZK');
        expect(result.remainingBalance.currency).toBe('CZK');
    });

    it('nemutuje vstup -- snapshot poukazu zůstane po evaluate() nedotčený', () => {
        const input = redemptionInput();
        const balanceBefore = input.currentBalance.amount.toString();

        rule.evaluate(input);

        expect(input.currentBalance.amount.toString()).toBe(balanceBefore);
        expect(input.status).toBe('ACTIVE');
    });
});

describe('CreditVoucherRedemptionRule -- zamítnutí (§8 podmínky platnosti)', () => {
    const rule = new CreditVoucherRedemptionRule(ctx);

    it('expirovaný poukaz -> allowed:false s důvodem EXPIRED', () => {
        const result = rule.evaluate(redemptionInput({ expiresAt: PAST }));

        expect(result.allowed).toBe(false);
        expect(result.reasonCode).toBe('EXPIRED');
        expect(result.reason).toBeTruthy();
    });

    it.each<[CreditVoucherLifecycleState]>([['CANCELLED'], ['EXPIRED'], ['DEPLETED']])(
        'poukaz ve stavu %s -> allowed:false s důvodem NOT_ACTIVE',
        (status) => {
            const result = rule.evaluate(redemptionInput({ status }));

            expect(result.allowed).toBe(false);
            expect(result.reasonCode).toBe('NOT_ACTIVE');
            // Hláška musí pojmenovat konkrétní stav, ať podpora nehádá.
            expect(result.reason).toContain(status);
        }
    );

    it('ACTIVE poukaz s nulovým zůstatkem -> DEPLETED (data se rozešla se stavem, přesto fail-closed)', () => {
        const result = rule.evaluate(redemptionInput({ currentBalance: czk('0') }));

        expect(result.allowed).toBe(false);
        expect(result.reasonCode).toBe('DEPLETED');
    });

    it('košík v jiné měně než poukaz -> allowed:false, CURRENCY_MISMATCH (nikdy tichý přepočet)', () => {
        const result = rule.evaluate(redemptionInput({ cartTotal: eur('800') }));

        expect(result.allowed).toBe(false);
        expect(result.reasonCode).toBe('CURRENCY_MISMATCH');
        expect(result.redeemableAmount.amount.isZero()).toBe(true);
    });

    it('měna se kontroluje DŘÍV než stav -- jinak by se "cizí měna" schovala za NOT_ACTIVE', () => {
        const result = rule.evaluate(
            redemptionInput({ status: 'CANCELLED', cartTotal: eur('800') })
        );

        expect(result.reasonCode).toBe('CURRENCY_MISMATCH');
    });

    it('nerozparsovatelný timestamp -> INVALID_TIMESTAMP, ne tiché "platný"', () => {
        const result = rule.evaluate(redemptionInput({ expiresAt: 'není datum' }));

        expect(result.allowed).toBe(false);
        expect(result.reasonCode).toBe('INVALID_TIMESTAMP');
    });

    it('nulový košík -> ZERO_CART_TOTAL, odlišeno od záporného (pro UI to není chyba)', () => {
        const result = rule.evaluate(redemptionInput({ cartTotal: czk('0') }));

        expect(result.allowed).toBe(false);
        expect(result.reasonCode).toBe('ZERO_CART_TOTAL');
    });

    it('záporný košík -> NEGATIVE_CART_TOTAL, nikdy "vrácení" kreditu', () => {
        const result = rule.evaluate(redemptionInput({ cartTotal: czk('-100') }));

        expect(result.allowed).toBe(false);
        expect(result.reasonCode).toBe('NEGATIVE_CART_TOTAL');
        // Zamítnutí NESMÍ zůstatek zvýšit.
        expect(result.remainingBalance.amount.toString()).toBe('1500');
    });

    it('zamítnutí nemění nic: nula k čerpání, zůstatek i stav beze změny', () => {
        const result = rule.evaluate(redemptionInput({ status: 'CANCELLED' }));

        expect(result.redeemableAmount.amount.isZero()).toBe(true);
        expect(result.remainingBalance.amount.toString()).toBe('1500');
        expect(result.resultingStatus).toBe('CANCELLED');
    });
});

describe('CreditVoucherRedemptionRule -- determinismus (Rule.ts TVRDÝ POŽADAVEK)', () => {
    const rule = new CreditVoucherRedemptionRule(ctx);

    it('stejný vstup 100x -> 100x identický výsledek', () => {
        const input = redemptionInput({ currentBalance: czk('1500'), cartTotal: czk('800') });
        const serialize = (r: ReturnType<typeof rule.evaluate>) =>
            JSON.stringify({
                allowed: r.allowed,
                reasonCode: r.reasonCode,
                redeemable: r.redeemableAmount.amount.toString(),
                remaining: r.remainingBalance.amount.toString(),
                status: r.resultingStatus,
            });

        const first = serialize(rule.evaluate(input));
        for (let i = 0; i < 99; i += 1) {
            expect(serialize(rule.evaluate(input))).toBe(first);
        }
    });

    it('`now` hluboko v MINULOSTI: expirace 2027 ještě nenastala -> čerpání povoleno', () => {
        // Kdyby Rule sáhla na Date.now(), tenhle test i ten následující by
        // dopadly podle skutečného kalendáře, ne podle vstupu.
        const result = rule.evaluate(
            redemptionInput({ now: '2020-01-01T00:00:00Z', expiresAt: '2027-09-06T12:00:00Z' })
        );

        expect(result.allowed).toBe(true);
        expect(result.redeemableAmount.amount.toString()).toBe('800');
    });

    it('`now` hluboko v BUDOUCNOSTI: tentýž poukaz je expirovaný -> zamítnuto', () => {
        const result = rule.evaluate(
            redemptionInput({ now: '2099-01-01T00:00:00Z', expiresAt: '2027-09-06T12:00:00Z' })
        );

        expect(result.allowed).toBe(false);
        expect(result.reasonCode).toBe('EXPIRED');
    });

    it('výsledek závisí VÝHRADNĚ na vstupu -- reálný čas běhu testu ho neovlivní', () => {
        // `now` je PŘED `expiresAt`, takže poukaz platí a Rule musí povolit
        // čerpání -- bez ohledu na to, kdy test reálně běží. Kdyby Rule sáhla
        // na Date.now(), tenhle test by po 2026-06-01 začal padat sám od sebe.
        const stillValid = redemptionInput({
            now: '2026-01-01T00:00:00Z',
            expiresAt: '2026-06-01T00:00:00Z',
        });
        const a = rule.evaluate(stillValid);
        const b = rule.evaluate({ ...stillValid });

        expect(a.reasonCode).toBe(b.reasonCode);
        expect(a.allowed).toBe(true);

        // Opačný směr téhož: `now` až PO expiraci -> zamítnuto, taky nezávisle
        // na reálném kalendáři.
        const expired = redemptionInput({
            now: '2026-07-01T00:00:00Z',
            expiresAt: '2026-06-01T00:00:00Z',
        });
        const c = rule.evaluate(expired);

        expect(c.allowed).toBe(false);
        expect(c.reasonCode).toBe('EXPIRED');
    });
});

describe('CreditVoucherRedemptionRule -- peníze jako Decimal, nikdy float', () => {
    const rule = new CreditVoucherRedemptionRule(ctx);

    it('haléře: 100.05 z poukazu 100.10 -> zbývá přesně 0.05', () => {
        const result = rule.evaluate(
            redemptionInput({ currentBalance: czk('100.10'), cartTotal: czk('100.05') })
        );

        expect(result.redeemableAmount.amount.toString()).toBe('100.05');
        expect(result.remainingBalance.amount.toString()).toBe('0.05');
        expect(result.resultingStatus).toBe('ACTIVE');
    });

    it('klasický 0.1 + 0.2: zůstatek 0.3, košík 0.1+0.2 -> vyčerpáno na nulu, ne 0.00000000000000004', () => {
        const cart = new Decimal('0.1').plus(new Decimal('0.2'));
        const result = rule.evaluate(
            redemptionInput({
                currentBalance: czk('0.3'),
                cartTotal: { amount: cart, currency: 'CZK' },
            })
        );

        expect(cart.toString()).toBe('0.3');
        expect(result.remainingBalance.amount.isZero()).toBe(true);
        expect(result.resultingStatus).toBe('DEPLETED');
    });

    it('víc než dvě desetinná místa se NEZAOKROUHLUJÍ -- zaokrouhlení patří perzistenční vrstvě', () => {
        const result = rule.evaluate(
            redemptionInput({ currentBalance: czk('10.005'), cartTotal: czk('3.3333') })
        );

        expect(result.redeemableAmount.amount.toString()).toBe('3.3333');
        expect(result.remainingBalance.amount.toString()).toBe('6.6717');
    });

    it('velká částka nepřeteče přes float přesnost', () => {
        const result = rule.evaluate(
            redemptionInput({
                currentBalance: czk('9007199254740993.01'),
                cartTotal: czk('0.01'),
            })
        );

        expect(result.remainingBalance.amount.toString()).toBe('9007199254740993');
    });
});

const validityInput = (
    over: Partial<CreditVoucherValidityRuleInput> = {}
): CreditVoucherValidityRuleInput => ({
    status: 'ACTIVE',
    expiresAt: FUTURE,
    currentBalance: czk('500'),
    now: NOW,
    ...over,
});

describe('CreditVoucherValidityRule -- §8 tři podmínky a jejich kombinace', () => {
    const rule = new CreditVoucherValidityRule(ctx);

    it('ACTIVE + neexpirováno + zůstatek > 0 -> platný, všechny tři checky true', () => {
        const result = rule.evaluate(validityInput());

        expect(result.valid).toBe(true);
        expect(result.checks).toEqual({ isActive: true, isNotExpired: true, hasBalance: true });
        expect(result.reasonCode).toBeUndefined();
    });

    it('jen stav porušen -> NOT_ACTIVE, ostatní dva checky zůstávají true (volající vidí PROČ)', () => {
        const result = rule.evaluate(validityInput({ status: 'CANCELLED' }));

        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe('NOT_ACTIVE');
        expect(result.checks).toEqual({ isActive: false, isNotExpired: true, hasBalance: true });
    });

    it('jen expirace porušena -> EXPIRED', () => {
        const result = rule.evaluate(validityInput({ expiresAt: PAST }));

        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe('EXPIRED');
        expect(result.checks).toEqual({ isActive: true, isNotExpired: false, hasBalance: true });
    });

    it('jen zůstatek porušen -> DEPLETED', () => {
        const result = rule.evaluate(validityInput({ currentBalance: czk('0') }));

        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe('DEPLETED');
        expect(result.checks).toEqual({ isActive: true, isNotExpired: true, hasBalance: false });
    });

    it('KOMBINACE stav + expirace -> hlásí NOT_ACTIVE (stav má přednost), ale checks nese obojí', () => {
        const result = rule.evaluate(validityInput({ status: 'CANCELLED', expiresAt: PAST }));

        expect(result.reasonCode).toBe('NOT_ACTIVE');
        expect(result.checks).toEqual({ isActive: false, isNotExpired: false, hasBalance: true });
    });

    it('KOMBINACE expirace + nulový zůstatek -> hlásí EXPIRED (pořadí EXPIRED před DEPLETED)', () => {
        const result = rule.evaluate(
            validityInput({ expiresAt: PAST, currentBalance: czk('0') })
        );

        expect(result.reasonCode).toBe('EXPIRED');
        expect(result.checks).toEqual({ isActive: true, isNotExpired: false, hasBalance: false });
    });

    it('VŠECHNY TŘI porušené -> jeden důvod NOT_ACTIVE, ale checks řeknou celou pravdu', () => {
        const result = rule.evaluate(
            validityInput({ status: 'EXPIRED', expiresAt: PAST, currentBalance: czk('0') })
        );

        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe('NOT_ACTIVE');
        expect(result.checks).toEqual({ isActive: false, isNotExpired: false, hasBalance: false });
    });
});

describe('CreditVoucherValidityRule -- hraniční případy', () => {
    const rule = new CreditVoucherValidityRule(ctx);

    it('expiresAt === now -> NEPLATNÝ; §8 má ostrou nerovnost `expires_at > NOW()`', () => {
        const result = rule.evaluate(validityInput({ expiresAt: NOW, now: NOW }));

        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe('EXPIRED');
        expect(result.checks.isNotExpired).toBe(false);
    });

    it('milisekunda PŘED expirací -> ještě platný', () => {
        const result = rule.evaluate(
            validityInput({ expiresAt: '2026-09-06T12:00:00.001Z', now: NOW })
        );

        expect(result.valid).toBe(true);
    });

    it('milisekunda PO expiraci -> už neplatný', () => {
        const result = rule.evaluate(
            validityInput({ expiresAt: NOW, now: '2026-09-06T12:00:00.001Z' })
        );

        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe('EXPIRED');
    });

    it('rozdílný zápis téhož okamžiku (offset vs. Z) se porovnává jako okamžik, ne jako text', () => {
        const result = rule.evaluate(
            validityInput({ expiresAt: '2026-09-06T14:00:00+02:00', now: NOW })
        );

        // 14:00+02:00 === 12:00Z -> shodný okamžik -> stejně jako expiresAt === now.
        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe('EXPIRED');
    });

    it('zůstatek přesně 0 -> DEPLETED, nula NENÍ "něco k čerpání"', () => {
        const result = rule.evaluate(validityInput({ currentBalance: czk('0.00') }));

        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe('DEPLETED');
        expect(result.checks.hasBalance).toBe(false);
    });

    it('zůstatek 0.01 (jeden haléř) -> platný, hranice je ostrá `> 0`', () => {
        const result = rule.evaluate(validityInput({ currentBalance: czk('0.01') }));

        expect(result.valid).toBe(true);
        expect(result.checks.hasBalance).toBe(true);
    });

    it('záporný zůstatek (poškozená data) -> zamítnut, ne "platný, ale minus"', () => {
        const result = rule.evaluate(validityInput({ currentBalance: czk('-0.01') }));

        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe('DEPLETED');
    });

    it('nerozparsovatelný `now` -> INVALID_TIMESTAMP, fail-closed', () => {
        const result = rule.evaluate(validityInput({ now: 'zítra' }));

        expect(result.valid).toBe(false);
        expect(result.reasonCode).toBe('INVALID_TIMESTAMP');
        expect(result.checks.isNotExpired).toBe(false);
    });

    it('stejný vstup 100x -> stejný výsledek (determinismus i tady)', () => {
        const input = validityInput({ expiresAt: NOW, now: NOW });
        const first = JSON.stringify(rule.evaluate(input));
        for (let i = 0; i < 99; i += 1) {
            expect(JSON.stringify(rule.evaluate(input))).toBe(first);
        }
    });
});

describe('CreditVoucherLifecycleRule -- §7 stavový diagram', () => {
    const rule = new CreditVoucherLifecycleRule(ctx);
    const allStates: CreditVoucherLifecycleState[] = [
        'ACTIVE',
        'DEPLETED',
        'EXPIRED',
        'CANCELLED',
    ];

    it('KRITICKÉ: DEPLETED -> ACTIVE je DOVOLENÝ -- bez toho není refundace možná', () => {
        const result = rule.evaluate({ currentStatus: 'DEPLETED', targetStatus: 'ACTIVE' });

        expect(result.allowed).toBe(true);
    });

    it('ACTIVE -> DEPLETED (vyčerpání) je dovolený', () => {
        expect(rule.evaluate({ currentStatus: 'ACTIVE', targetStatus: 'DEPLETED' }).allowed).toBe(
            true
        );
    });

    it.each<[CreditVoucherLifecycleState]>([['EXPIRED'], ['CANCELLED']])(
        'ACTIVE -> %s je dovolený',
        (target) => {
            expect(rule.evaluate({ currentStatus: 'ACTIVE', targetStatus: target }).allowed).toBe(
                true
            );
        }
    );

    it.each<[CreditVoucherLifecycleState]>([['EXPIRED'], ['CANCELLED']])(
        'DEPLETED -> %s je dovolený (vyčerpaný poukaz smí ještě vypršet i být stornován)',
        (target) => {
            expect(
                rule.evaluate({ currentStatus: 'DEPLETED', targetStatus: target }).allowed
            ).toBe(true);
        }
    );

    it.each(allStates)('KRITICKÉ: EXPIRED -> %s je ZAKÁZANÝ (čas neteče zpět)', (target) => {
        const result = rule.evaluate({ currentStatus: 'EXPIRED', targetStatus: target });

        expect(result.allowed).toBe(false);
        expect(result.reason).toBeTruthy();
    });

    it.each(allStates)('KRITICKÉ: CANCELLED -> %s je ZAKÁZANÝ (storno je konečné)', (target) => {
        const result = rule.evaluate({ currentStatus: 'CANCELLED', targetStatus: target });

        expect(result.allowed).toBe(false);
        expect(result.reason).toBeTruthy();
    });

    it('ACTIVE -> ACTIVE je ZAKÁZANÝ -- částečné čerpání není přechod a nesmí projít auditem', () => {
        const result = rule.evaluate({ currentStatus: 'ACTIVE', targetStatus: 'ACTIVE' });

        expect(result.allowed).toBe(false);
    });

    it('DEPLETED -> DEPLETED je ZAKÁZANÝ -- self-transition osa neuvádí ani tady', () => {
        expect(
            rule.evaluate({ currentStatus: 'DEPLETED', targetStatus: 'DEPLETED' }).allowed
        ).toBe(false);
    });

    it('FAIL-CLOSED: nedeklarovaný cílový stav (data zvenčí) je zamítnutý, ne propuštěný', () => {
        const result = rule.evaluate({
            currentStatus: 'ACTIVE',
            targetStatus: 'REFUNDED' as CreditVoucherLifecycleState,
        });

        expect(result.allowed).toBe(false);
    });

    it('FAIL-CLOSED: nedeklarovaný VÝCHOZÍ stav je zamítnutý', () => {
        const result = rule.evaluate({
            currentStatus: 'RESERVED' as CreditVoucherLifecycleState,
            targetStatus: 'ACTIVE',
        });

        expect(result.allowed).toBe(false);
    });

    it('celá matice 4x4: dovolené jsou PRÁVĚ přechody z §7, nic navíc', () => {
        const allowedPairs = new Set([
            'ACTIVE->DEPLETED',
            'ACTIVE->EXPIRED',
            'ACTIVE->CANCELLED',
            'DEPLETED->ACTIVE',
            'DEPLETED->EXPIRED',
            'DEPLETED->CANCELLED',
        ]);

        for (const from of allStates) {
            for (const to of allStates) {
                const expected = allowedPairs.has(`${from}->${to}`);
                expect(
                    rule.evaluate({ currentStatus: from, targetStatus: to }).allowed,
                    `${from} -> ${to}`
                ).toBe(expected);
            }
        }
    });

    it('zamítnutý přechod vždy nese důvod -- audit (§13) nesmí dostat holé false', () => {
        const result = rule.evaluate({ currentStatus: 'CANCELLED', targetStatus: 'ACTIVE' });

        expect(result.allowed).toBe(false);
        expect(typeof result.reason).toBe('string');
        expect(result.reason!.length).toBeGreaterThan(0);
    });
});

describe('isCreditVoucherTerminal -- terminální jsou JEN EXPIRED a CANCELLED', () => {
    it('EXPIRED a CANCELLED jsou terminální', () => {
        expect(isCreditVoucherTerminal('EXPIRED')).toBe(true);
        expect(isCreditVoucherTerminal('CANCELLED')).toBe(true);
    });

    it('DEPLETED NENÍ terminální -- refundace z něj vede zpět na ACTIVE', () => {
        expect(isCreditVoucherTerminal('DEPLETED')).toBe(false);
    });

    it('ACTIVE není terminální', () => {
        expect(isCreditVoucherTerminal('ACTIVE')).toBe(false);
    });
});

describe('Rules dohromady -- řetěz čerpání, jak ho volající skládá', () => {
    const redemption = new CreditVoucherRedemptionRule(ctx);
    const lifecycle = new CreditVoucherLifecycleRule(ctx);
    const validity = new CreditVoucherValidityRule(ctx);

    it('vyčerpání do nuly: Redemption vrátí DEPLETED a Lifecycle ten přechod dovolí', () => {
        const result = redemption.evaluate(
            redemptionInput({ currentBalance: czk('500'), cartTotal: czk('500') })
        );

        expect(result.resultingStatus).toBe('DEPLETED');
        expect(
            lifecycle.evaluate({ currentStatus: 'ACTIVE', targetStatus: result.resultingStatus })
                .allowed
        ).toBe(true);
    });

    it('částečné čerpání: Redemption vrátí ACTIVE a Lifecycle ten "přechod" NEDOVOLÍ -- volající ho ani nesmí hlásit', () => {
        const result = redemption.evaluate(redemptionInput());

        expect(result.resultingStatus).toBe('ACTIVE');
        expect(
            lifecycle.evaluate({ currentStatus: 'ACTIVE', targetStatus: result.resultingStatus })
                .allowed
        ).toBe(false);
    });

    it('Validity a Redemption se na uplatnitelnosti NEROZCHÁZEJÍ (obě čtou §8)', () => {
        const cases: Array<Partial<CreditVoucherRedemptionRuleInput>> = [
            {},
            { status: 'CANCELLED' },
            { status: 'DEPLETED' },
            { expiresAt: PAST },
            { expiresAt: NOW, now: NOW },
            { currentBalance: czk('0') },
            { currentBalance: czk('0.01') },
        ];

        for (const over of cases) {
            const input = redemptionInput(over);
            const r = redemption.evaluate(input);
            const v = validity.evaluate({
                status: input.status,
                expiresAt: input.expiresAt,
                currentBalance: input.currentBalance,
                now: input.now,
            });

            expect(r.allowed, JSON.stringify(over)).toBe(v.valid);
            if (!v.valid) {
                expect(r.reasonCode, JSON.stringify(over)).toBe(v.reasonCode);
            }
        }
    });

    it('po refundaci DEPLETED -> ACTIVE je poukaz zase uplatnitelný', () => {
        const afterRefund = validity.evaluate(
            validityInput({ status: 'ACTIVE', currentBalance: czk('500') })
        );

        expect(lifecycle.evaluate({ currentStatus: 'DEPLETED', targetStatus: 'ACTIVE' }).allowed).toBe(
            true
        );
        expect(afterRefund.valid).toBe(true);
    });
});
