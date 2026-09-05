// IdentityNormalizationRule -- migrace legacy normalization/identity.ts
// (connectors/safeorder/legacy/normalization/identity.ts) pod Nexus Rule
// contract. Fáze 2 pokračování (docs/MIGRATION_PLAN.md).
//
// Zachováno 1:1: canonicalizePhone (CZ/SK default country prefix,
// 00->+ konverze), canonicalizeEmail (lowercase+trim), canonicalizeStreet
// (diakritika strip přes NFD normalize, punctuation->space), canonicalizeZip
// (uppercase, no spaces), canonicalizeIdentity (sestaví "phone:...|email:...|
// addr:...|..." string, sort().join(';') pro deterministický výstup,
// throw pokud žádný atribut není k dispozici, throw na neznámou verzi).
// Čistá synchronní funkce -- legitimní Rule<> kandidát (na rozdíl od
// 2-identity-validator.ts stage, co volá async generateBlindToken po
// canonicalizeIdentity -- ten NENÍ migrován jako Rule).

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { canonicalizeIdentity } from '../../connectors/safeorder/legacy/normalization/identity.js';
import type { RawCustomerIdentity } from '../../connectors/safeorder/legacy/core/types.js';

export interface IdentityNormalizationRuleInput {
    readonly identity: RawCustomerIdentity;
    readonly version?: string;
}

export class IdentityNormalizationRule implements Rule<IdentityNormalizationRuleInput, string> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: IdentityNormalizationRuleInput): string {
        return canonicalizeIdentity(input.identity, input.version);
    }
}
