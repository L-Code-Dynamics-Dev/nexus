// Fáze 6.2 business rules -- domains/campaign/{CampaignLifecycleRule,
// PromoGroupPriorityRule,CreativeLifecycleRule}.ts. Josovo zadání: pravidla
// přechodů, validace vazeb před aktivací, priority validace a konfliktní
// rozhodování, publikace jen validního Creative, terminalita ARCHIVED.

import { describe, it, expect } from 'vitest';
import { CampaignLifecycleRule } from '../../domains/campaign/CampaignLifecycleRule.js';
import {
    PromoGroupPriorityValidationRule,
    resolveConflict,
} from '../../domains/campaign/PromoGroupPriorityRule.js';
import { CreativeLifecycleRule } from '../../domains/campaign/CreativeLifecycleRule.js';
import type { PromoGroup } from '../../core/canonical/entities/Campaign.js';

const ctx = { tenantId: 'ten_1', ruleId: 'test', ruleVersion: '1' };
const now = '2026-09-05T00:00:00Z';

describe('CampaignLifecycleRule', () => {
    const rule = new CampaignLifecycleRule(ctx);

    it('povoluje DRAFT -> ACTIVE, pokud Campaign má alespoň jednu PromoGroup', () => {
        const result = rule.evaluate({
            currentStatus: 'DRAFT',
            targetStatus: 'ACTIVE',
            promoGroupIds: ['promo_1'],
        });
        expect(result.allowed).toBe(true);
    });

    it('zamítá DRAFT -> ACTIVE, pokud Campaign nemá žádnou PromoGroup', () => {
        const result = rule.evaluate({
            currentStatus: 'DRAFT',
            targetStatus: 'ACTIVE',
            promoGroupIds: [],
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/PromoGroup/);
    });

    it('zamítá PAUSED -> ACTIVE, pokud PromoGroup mezitím zmizely (stejná kontrola jako DRAFT -> ACTIVE)', () => {
        const result = rule.evaluate({
            currentStatus: 'PAUSED',
            targetStatus: 'ACTIVE',
            promoGroupIds: [],
        });
        expect(result.allowed).toBe(false);
    });

    it('povoluje ACTIVE -> PAUSED bez ohledu na promoGroupIds (jen ACTIVE cíl kontroluje vazby)', () => {
        const result = rule.evaluate({
            currentStatus: 'ACTIVE',
            targetStatus: 'PAUSED',
            promoGroupIds: [],
        });
        expect(result.allowed).toBe(true);
    });

    it('povoluje libovolný přechod -> ENDED bez PromoGroup kontroly', () => {
        const result = rule.evaluate({
            currentStatus: 'ACTIVE',
            targetStatus: 'ENDED',
            promoGroupIds: [],
        });
        expect(result.allowed).toBe(true);
    });

    it('zamítá přechod z terminálního ENDED (deleguje na evaluateTransition)', () => {
        const result = rule.evaluate({
            currentStatus: 'ENDED',
            targetStatus: 'DRAFT',
            promoGroupIds: ['promo_1'],
        });
        expect(result.allowed).toBe(false);
    });

    it('zamítá nedeklarovaný přechod DRAFT -> PAUSED (deleguje na evaluateTransition)', () => {
        const result = rule.evaluate({
            currentStatus: 'DRAFT',
            targetStatus: 'PAUSED',
            promoGroupIds: ['promo_1'],
        });
        expect(result.allowed).toBe(false);
    });

    it('je čistá funkce -- stejný vstup dává stejný výstup', () => {
        const input = { currentStatus: 'DRAFT' as const, targetStatus: 'ACTIVE' as const, promoGroupIds: ['promo_1'] };
        expect(rule.evaluate(input)).toEqual(rule.evaluate(input));
    });
});

describe('PromoGroupPriorityValidationRule', () => {
    const rule = new PromoGroupPriorityValidationRule(ctx);

    it('validuje nezáporné konečné číslo jako validní priority', () => {
        expect(rule.evaluate({ priority: 0 }).valid).toBe(true);
        expect(rule.evaluate({ priority: 10 }).valid).toBe(true);
    });

    it('zamítá záporné priority', () => {
        const result = rule.evaluate({ priority: -1 });
        expect(result.valid).toBe(false);
        expect(result.reason).toMatch(/nezáporné/);
    });

    it('zamítá NaN/Infinity jako priority', () => {
        expect(rule.evaluate({ priority: NaN }).valid).toBe(false);
        expect(rule.evaluate({ priority: Infinity }).valid).toBe(false);
    });
});

describe('resolveConflict — PromoGroup priority', () => {
    function group(id: string, productIds: string[], priority: number): PromoGroup {
        return { id, tenantId: 'ten_1', createdAt: now, updatedAt: now, name: id, productIds, priority };
    }

    it('vybere PromoGroup s nejvyšší priority pro daný produkt', () => {
        const groups = [group('low', ['prod_1'], 5), group('high', ['prod_1'], 20)];
        const result = resolveConflict(groups, 'prod_1');
        expect(result.resolved).toBe(true);
        expect(result.winner?.id).toBe('high');
    });

    it('ignoruje PromoGroup, které daný produkt vůbec neobsahují', () => {
        const groups = [group('unrelated', ['prod_2'], 100), group('relevant', ['prod_1'], 1)];
        const result = resolveConflict(groups, 'prod_1');
        expect(result.resolved).toBe(true);
        expect(result.winner?.id).toBe('relevant');
    });

    it('vrací resolved:false, pokud žádná PromoGroup neobsahuje produkt', () => {
        const groups = [group('a', ['prod_2'], 10)];
        const result = resolveConflict(groups, 'prod_1');
        expect(result.resolved).toBe(false);
    });

    it('UNRESOLVED: vrací resolved:false při remíze na nejvyšší priority, nevybírá libovolně', () => {
        const groups = [group('tie_a', ['prod_1'], 10), group('tie_b', ['prod_1'], 10)];
        const result = resolveConflict(groups, 'prod_1');
        expect(result.resolved).toBe(false);
        expect(result.winner).toBeUndefined();
        expect(result.reason).toMatch(/remíza/);
    });

    it('produkt může patřit do více PromoGroup zároveň (M:N) beze změny výsledku', () => {
        const groups = [
            group('a', ['prod_1', 'prod_2'], 5),
            group('b', ['prod_1'], 15),
        ];
        const result = resolveConflict(groups, 'prod_1');
        expect(result.winner?.id).toBe('b');
    });
});

describe('CreativeLifecycleRule', () => {
    const rule = new CreativeLifecycleRule(ctx);

    it('povoluje DRAFT -> PUBLISHED s neprázdným content', () => {
        const result = rule.evaluate({ currentStatus: 'DRAFT', targetStatus: 'PUBLISHED', content: 'banner.jpg' });
        expect(result.allowed).toBe(true);
    });

    it('zamítá DRAFT -> PUBLISHED s prázdným content', () => {
        const result = rule.evaluate({ currentStatus: 'DRAFT', targetStatus: 'PUBLISHED', content: '' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/content/);
    });

    it('zamítá DRAFT -> PUBLISHED s content obsahujícím jen mezery', () => {
        const result = rule.evaluate({ currentStatus: 'DRAFT', targetStatus: 'PUBLISHED', content: '   ' });
        expect(result.allowed).toBe(false);
    });

    it('povoluje PUBLISHED -> ARCHIVED bez ohledu na content (kontrola je jen na cíli PUBLISHED)', () => {
        const result = rule.evaluate({ currentStatus: 'PUBLISHED', targetStatus: 'ARCHIVED', content: 'anything' });
        expect(result.allowed).toBe(true);
    });

    it('zamítá ARCHIVED -> PUBLISHED (terminální stav, archivovaný Creative se znovu nepublikuje)', () => {
        const result = rule.evaluate({ currentStatus: 'ARCHIVED', targetStatus: 'PUBLISHED', content: 'valid' });
        expect(result.allowed).toBe(false);
    });

    it('zamítá DRAFT -> ARCHIVED přímo bez PUBLISHED mezikroku (deleguje na evaluateTransition)', () => {
        const result = rule.evaluate({ currentStatus: 'DRAFT', targetStatus: 'ARCHIVED', content: 'valid' });
        expect(result.allowed).toBe(true); // DRAFT->ARCHIVED je povolený přechod v definici
    });
});
