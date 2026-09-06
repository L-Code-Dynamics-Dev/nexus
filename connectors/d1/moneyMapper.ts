// moneyMapper -- převod `Money{Decimal}` <-> INTEGER v HALÉŘÍCH (minor units).
// Connector Layer, Fáze A "Voucher Core"
// (docs/design-proposals/Digital-Voucher.md §3, migrations/0001_credit_voucher.sql).
//
// PROČ TENHLE SOUBOR EXISTUJE:
//   Doména pracuje výhradně s `Money{Decimal}` (core/canonical/entities/base.ts:
//   "Peníze vždy jako Decimal, nikdy float"). D1 schéma ukládá peníze jako
//   INTEGER v haléřích (sloupce se sufixem `_minor`) -- SQLite nemá DECIMAL
//   a `REAL` je IEEE-754 float, na kterém se reconciliační invariant
//   (CreditVoucher.ts RECONCILIATION CONTRACT) rozejde po dost malém počtu
//   operací.
//
//   Převod je proto věcí PERZISTENČNÍ VRSTVY -- entita halíře nikdy nevidí,
//   Worker nikdy nevidí float. Tenhle modul je JEDINÉ místo, kde se ty dva
//   světy potkávají.
//
// ZAOKROUHLOVÁNÍ SE TU NEDĚJE. NIKDY. IMPLICITNĚ UŽ VŮBEC NE:
//   `moneyToMinor()` na částce s víc než dvěma desetinnými místy HODÍ CHYBU
//   místo tichého zaokrouhlení. Rozdíl proti `workers/api/routes/voucher.ts`
//   (`.times(100).toFixed(0)`, ROUND_HALF_UP) je záměrný a je to zpřísnění:
//   tam vstup vzniká uvnitř Rule jako `min(zůstatek, košík)` z hodnot
//   dělených stem, takže zlomek haléře je nemožný a zaokrouhlení je mrtvá
//   pojistka. SEM ale vstupuje cokoli, co volající sestrojí -- a tichá ztráta
//   přesnosti u PLATIDLA je nepřijatelná: 0,005 Kč krát milion operací je
//   reálná díra v penězích a nikde by po ní nezůstala stopa.
//   Kdo potřebuje zaokrouhlit, musí to udělat VĚDOMĚ a VÝŠE, ve své vrstvě,
//   kde je jasné, podle jakého pravidla se zaokrouhluje a kdo to schválil.

import Decimal from 'decimal.js';
import type { Money } from '../../core/canonical/entities/base.js';

/** Počet desetinných míst minor units. 100 haléřů = 1 Kč. */
const MINOR_UNIT_SCALE = 2;
const MINOR_UNIT_FACTOR = new Decimal(10).pow(MINOR_UNIT_SCALE);

/**
 * Chyba převodu peněz. Vlastní třída, ne holý `Error`: volající (Worker,
 * store) musí umět odlišit "špatně sestrojená částka" od I/O chyby D1 --
 * první je programátorská chyba (500 / oprava kódu), druhá je dočasný
 * výpadek (503 / retry). Bez vlastního typu se to pozná jen podle textu
 * hlášky, což je přesně ten druh křehkosti, který v peněžní cestě nechceme.
 */
export class MoneyConversionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MoneyConversionError';
    }
}

/**
 * `Money{Decimal}` -> celé haléře (`INTEGER`).
 *
 * FAIL-CLOSED. Hodí `MoneyConversionError`, pokud:
 *   - částka není konečné číslo (NaN / Infinity -- typicky výsledek dělení
 *     nulou o pár vrstev výš, který by se jinak do DB dostal jako `null`
 *     nebo `0` a tiše smazal peníze),
 *   - má víc než 2 desetinná místa (tichá ztráta přesnosti u platidla),
 *   - výsledek by přetekl `Number.MAX_SAFE_INTEGER` (nad tou hranicí přestává
 *     být celočíselná aritmetika v JS přesná a `bind()` by poslal do D1
 *     jinou hodnotu, než jakou vidí kód -- neviditelná koruna navíc i míň).
 *
 * ZNAMÉNKO SE TU NEHLÍDÁ: transakční invariant "částka je vždy kladná, směr
 * nese `type`" patří doméně (CreditVoucher.ts invariant 1) a DB CHECKu
 * (`ck_vtx_amount_positive`), ne mapperu. Mapper je čistý převod jednotek --
 * kdyby si k tomu přibral business pravidlo, musel by ho někdo obcházet
 * v okamžiku, kdy vznikne první legitimní záporná hodnota (např. rozdíl
 * dvou zůstatků při reconciliaci).
 */
export function moneyToMinor(money: Money): number {
    const amount = money.amount;

    if (!amount.isFinite()) {
        throw new MoneyConversionError(
            `Money amount must be finite, got "${amount.toString()}" (${money.currency})`
        );
    }

    // `decimalPlaces()` počítá skutečná desetinná místa hodnoty, ne délku
    // zápisu -- `1.50` je 1 místo, `1.005` jsou 3. Přesně to, co je potřeba.
    if (amount.decimalPlaces() > MINOR_UNIT_SCALE) {
        throw new MoneyConversionError(
            `Money amount "${amount.toString()}" ${money.currency} has more than ` +
                `${MINOR_UNIT_SCALE} decimal places and cannot be stored as minor units ` +
                `without losing precision. Round explicitly before persisting -- ` +
                `this mapper never rounds silently.`
        );
    }

    // Násobení v Decimalu, ne přes `Number`: převod přes float by u velkých
    // částek ztratil právě tu přesnost, kvůli které se Decimal používá.
    const minor = amount.times(MINOR_UNIT_FACTOR);

    // Po kontrole desetinných míst tohle už nemůže nastat -- je to pojistka
    // pro případ, že by někdo `MINOR_UNIT_SCALE` změnil a kontrolu ne.
    if (!minor.isInteger()) {
        throw new MoneyConversionError(
            `Money amount "${amount.toString()}" ${money.currency} does not convert to a whole ` +
                `number of minor units (got "${minor.toString()}")`
        );
    }

    if (minor.abs().greaterThan(Number.MAX_SAFE_INTEGER)) {
        throw new MoneyConversionError(
            `Money amount "${amount.toString()}" ${money.currency} exceeds the safe integer ` +
                `range in minor units (got "${minor.toString()}", limit ${Number.MAX_SAFE_INTEGER})`
        );
    }

    return minor.toNumber();
}

/**
 * Celé haléře (`INTEGER` z D1) -> `Money{Decimal}`.
 *
 * FAIL-CLOSED i tady, přestože zdroj je "vlastní" databáze: sloupec může
 * dostat hodnotu z migrace, z ručního zásahu v konzoli, nebo z budoucí verze
 * schématu. Nedůvěřovat vstupu z DB je levnější než dohledávat, kde se vzala
 * částka `NaN` na poukazu.
 *
 * `dividedBy(100)` je v Decimalu přesné dělení mocninou desítky, žádná ztráta.
 */
export function minorToMoney(minor: number, currency: string): Money {
    if (!Number.isFinite(minor)) {
        throw new MoneyConversionError(`Minor units must be a finite number, got "${minor}"`);
    }
    if (!Number.isInteger(minor)) {
        throw new MoneyConversionError(
            `Minor units must be a whole number (haléře), got "${minor}" -- ` +
                `a fractional minor unit means the column was written by something ` +
                `that bypassed moneyToMinor()`
        );
    }
    if (!Number.isSafeInteger(minor)) {
        throw new MoneyConversionError(
            `Minor units "${minor}" are outside the safe integer range and cannot be ` +
                `converted without losing precision`
        );
    }
    if (currency.length === 0) {
        // Prázdná měna by prošla až do porovnání `assertSameCurrency` a tam
        // vypadala jako neshoda měn, ne jako rozbitý řádek. Fail tady je
        // čitelnější.
        throw new MoneyConversionError(`Currency must not be empty (minor units "${minor}")`);
    }

    return { amount: new Decimal(minor).dividedBy(MINOR_UNIT_FACTOR), currency };
}
