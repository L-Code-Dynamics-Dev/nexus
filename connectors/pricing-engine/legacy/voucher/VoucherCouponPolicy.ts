// Legacy port 1:1 z "L-Code Pricing Engine(API) doplněk Shoptet"
// (src/core/policies/VoucherCouponPolicy.ts) -- beze změny logiky.
// Zero dependency na API/prostředí -- použitelné v API módu, Non-API CSV
// módu i browser DOM. Rozlišuje VOUCHER (dárkový poukaz = platidlo, ignoruje
// stav slevy, počítá z celého košíku) od COUPON (slevový kód, respektuje
// allowOnSaleItems flag a vylučuje již zlevněné položky ze základu výpočtu).

export type CodeType = 'VOUCHER' | 'COUPON';

export interface CodeDefinition {
    code: string;
    type: CodeType;
    /** For VOUCHER: absolute monetary value (e.g. 50 EUR). For COUPON: percentage (e.g. 10%) or absolute value */
    value: number;
    /** Whether value is a percentage (true) or fixed amount (false) */
    isPercentage: boolean;
    /** If false, this coupon CANNOT be applied to items that are already discounted / on sale */
    allowOnSaleItems: boolean;
}

export interface CartItemInput {
    sku: string;
    unitPrice: number;
    standardUnitPrice: number;
    quantity: number;
    isOnSale: boolean;
    hasVipDiscount: boolean;
}

export interface CouponEvaluationResult {
    code: string;
    type: CodeType;
    applicableDiscountTotal: number;
    eligibleItemSkus: string[];
    excludedItemSkus: string[];
    message?: string;
}

export class VoucherCouponPolicy {
    static evaluateCode(codeDef: CodeDefinition, items: CartItemInput[]): CouponEvaluationResult {
        if (codeDef.type === 'VOUCHER') {
            // Gift Voucher behaves as a prepaid payment asset (platidlo)
            // It applies to the ENTIRE cart total regardless of sale/discount status
            const cartTotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
            const discountValue = Math.min(codeDef.value, cartTotal);
            return {
                code: codeDef.code,
                type: 'VOUCHER',
                applicableDiscountTotal: Math.round(discountValue * 100) / 100,
                eligibleItemSkus: items.map(i => i.sku),
                excludedItemSkus: [],
                message: `Dárkový poukaz uplatněn jako platidlo (-${discountValue.toFixed(2)} €)`,
            };
        }

        // DISCOUNT COUPON LOGIC
        const eligibleItems = items.filter(item => {
            if (codeDef.allowOnSaleItems) return true;
            // Exclude items that are already discounted or on sale
            return !item.isOnSale && !item.hasVipDiscount && item.unitPrice >= item.standardUnitPrice;
        });

        const excludedItems = items.filter(item => !eligibleItems.includes(item));

        if (eligibleItems.length === 0) {
            return {
                code: codeDef.code,
                type: 'COUPON',
                applicableDiscountTotal: 0,
                eligibleItemSkus: [],
                excludedItemSkus: items.map(i => i.sku),
                message: 'Slevový kód nelze uplatnit, protože košík obsahuje pouze akční nebo již zlevněné zboží.',
            };
        }

        let discountTotal = 0;
        const eligibleCartSubtotal = eligibleItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

        if (codeDef.isPercentage) {
            discountTotal = (eligibleCartSubtotal * codeDef.value) / 100;
        } else {
            discountTotal = Math.min(codeDef.value, eligibleCartSubtotal);
        }

        const message = excludedItems.length > 0
            ? `Slevový kód uplatněn pouze na nezlevněné položky (-${discountTotal.toFixed(2)} €).`
            : `Slevový kód uplatněn (-${discountTotal.toFixed(2)} €).`;

        return {
            code: codeDef.code,
            type: 'COUPON',
            applicableDiscountTotal: Math.round(discountTotal * 100) / 100,
            eligibleItemSkus: eligibleItems.map(i => i.sku),
            excludedItemSkus: excludedItems.map(i => i.sku),
            message,
        };
    }
}
