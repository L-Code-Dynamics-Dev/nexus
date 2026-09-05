// BlindToken -- re-export legacy blind-token.ts (connectors/safeorder/
// legacy/crypto/blind-token.ts) BEZ Rule<> wrapperu. Fáze 2
// (docs/MIGRATION_PLAN.md).
//
// DŮVOD, PROČ TOHLE NENÍ Rule<TInput, TResult>: core/canonical/rules/
// Rule.ts kontrakt vyžaduje "čistá funkce bez I/O", evaluate() je
// synchronní (TResult, ne Promise<TResult>). generateBlindToken/
// verifyBlindToken jsou async (Web Crypto API -- crypto.subtle.sign/
// digest je vždy async, i lokálně, žádná I/O v sítovém smyslu, ale
// porušuje synchronní kontrakt). Toto je kryptografická utilita, ne
// byznys rozhodovací pravidlo -- nenutíme ji do nesprávného kontraktu
// jen kvůli konzistenci; zůstává samostatná funkce.

export { generateBlindToken, verifyBlindToken, type BlindTokenDomain } from '../../connectors/safeorder/legacy/crypto/blind-token.js';
