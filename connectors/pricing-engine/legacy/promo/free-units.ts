// Legacy port 1:1 z ~/hecmania-quantity-pricing/worker/src/promo/
// free-units.ts -- beze změny logiky. Hecmania promo: "X + X zdarma"
// (např. 2+1, 10+1, 20+2).
//
// SCOPE (definitivní specifikace, ověřeno na produkčním hecmania.cz
// košíku 2026-09-05): X+X NENÍ globální pravidlo. Je to vlastnost
// KONKRÉTNÍ VARIANTY -- každý produkt nese svůj vlastní poměr (nebo
// žádný). Produkt bez tohoto poměru není v X+X scope vůbec -- jeho
// množství se do X+X výpočtu nezapočítává.
//
// V rámci X+X produktu funguje QuantityTier SOUČASNĚ -- toto pravidlo
// řeší jen placené/zdarma kusy, cenu za kus řeší jiná pravidla (Highest
// Discount / PromoGroup / QuantityTier).

import Decimal from 'decimal.js';

export interface XPlusXRatio {
    paid: number;
    free: number;
}

export interface FreeUnitsRule {
    paidQty: number;
    freeQty: number;
}

export interface FreeUnitsResult {
    paidQty: number;
    freeQty: number;
    totalReceivedQty: number;
    appliedRule: FreeUnitsRule | null;
    nextRule: FreeUnitsRule | null;
    unitsToNextRule: number | null;
}

export function validateFreeUnitsRules(rules: FreeUnitsRule[]): FreeUnitsRule[] {
    for (const r of rules) {
        if (!Number.isInteger(r.paidQty) || r.paidQty <= 0) {
            throw new Error(`neplatné paidQty v pravidle X+X zdarma: ${JSON.stringify(r)}`);
        }
        if (!Number.isInteger(r.freeQty) || r.freeQty <= 0) {
            throw new Error(`neplatné freeQty v pravidle X+X zdarma: ${JSON.stringify(r)}`);
        }
    }
    return [...rules].sort((a, b) => a.paidQty - b.paidQty);
}

/**
 * Legacy/obecná cesta: globální práh-založená pravidla (10+1, 20+2) nad
 * jedním souhrnným množstvím. Ponecháno pro budoucí scope, kde by X+X bylo
 * skutečně definované jako globální množstevní práh (dosud nepotvrzeno) --
 * primární cesta pro Hecmanii je `resolveXPlusXForVariant` níže.
 */
export function resolveFreeUnits(paidQty: number, rules: FreeUnitsRule[]): FreeUnitsResult {
    const sorted = validateFreeUnitsRules(rules);

    if (paidQty <= 0 || sorted.length === 0) {
        return {
            paidQty,
            freeQty: 0,
            totalReceivedQty: paidQty,
            appliedRule: null,
            nextRule: sorted[0] ?? null,
            unitsToNextRule: sorted[0] ? sorted[0].paidQty - paidQty : null,
        };
    }

    let applied: FreeUnitsRule | null = null;
    let next: FreeUnitsRule | null = null;

    for (const rule of sorted) {
        if (rule.paidQty <= paidQty) {
            applied = rule;
        } else {
            next = rule;
            break;
        }
    }

    const freeQty = applied ? applied.freeQty : 0;

    return {
        paidQty,
        freeQty,
        totalReceivedQty: paidQty + freeQty,
        appliedRule: applied,
        nextRule: next,
        unitsToNextRule: next ? next.paidQty - paidQty : null,
    };
}

/**
 * Primární Hecmania cesta: X+X pravidlo pro JEDNU variantu s jejím vlastním
 * poměrem. Aplikuje se na množství TÉ VARIANTY, ne na souhrnné množství --
 * každá varianta v X+X scope se vyhodnocuje samostatně (opakovaně po
 * celých násobcích ratio).
 *
 * `qty` je CELKOVÝ počet kusů, které si zákazník vloží do košíku (ne jen
 * placené) -- ověřeno živě proti produkčnímu košíku hecmania.cz (ratio 2+1,
 * qty=20 celkem → 14 placených + 6 zdarma, NE 20 placených + 10 zdarma).
 *
 * Cyklus = paid + free. Počet plných cyklů = floor(qty / cyklus),
 * freeQty = plné_cykly × ratio.free, paidQty = qty − freeQty.
 */
export function resolveXPlusXForVariant(qty: number, ratio: XPlusXRatio): FreeUnitsResult {
    if (!Number.isInteger(ratio.paid) || ratio.paid <= 0) {
        throw new Error(`neplatné paid v X+X ratio: ${JSON.stringify(ratio)}`);
    }
    if (!Number.isInteger(ratio.free) || ratio.free <= 0) {
        throw new Error(`neplatné free v X+X ratio: ${JSON.stringify(ratio)}`);
    }

    const rule: FreeUnitsRule = { paidQty: ratio.paid, freeQty: ratio.free };
    const cycle = ratio.paid + ratio.free;

    if (qty <= 0) {
        return {
            paidQty: 0,
            freeQty: 0,
            totalReceivedQty: 0,
            appliedRule: null,
            nextRule: rule,
            unitsToNextRule: cycle,
        };
    }

    const fullCycles = Math.floor(qty / cycle);
    const freeQty = fullCycles * ratio.free;
    const paidQty = qty - freeQty;
    const remainder = qty - fullCycles * cycle;
    const unitsToNextMultiple = remainder > 0 ? cycle - remainder : cycle;

    return {
        paidQty,
        freeQty,
        totalReceivedQty: qty,
        appliedRule: fullCycles > 0 ? rule : null,
        nextRule: rule,
        unitsToNextRule: unitsToNextMultiple,
    };
}

/**
 * Efektivní cena za kus = (placené kusy × cena za kus) / (placené + zdarma kusy).
 * Pouze informativní -- NIKDY nenahrazuje ceníkovou cenu za kus v pipeline výsledku.
 */
export function effectivePricePerUnit(paidQty: number, pricePerUnit: Decimal, totalReceivedQty: number): Decimal | null {
    if (totalReceivedQty <= 0) return null;
    return new Decimal(paidQty).mul(pricePerUnit).dividedBy(totalReceivedQty);
}
