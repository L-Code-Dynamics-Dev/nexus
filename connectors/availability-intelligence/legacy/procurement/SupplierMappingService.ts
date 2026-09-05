export interface SupplierConfig {
    id: string;
    name: string;
    status: "ACTIVE" | "PAUSED" | "INACTIVE";
    statusLabel: string;
    categoryDescription: string;
    priority: number;
    leadTimeDays: number;
    leadTimeLabel: string;
    minOrderAmountCzk: number;
    minOrderLabel: string;
    orderMethod: "E-mail s tabulkou" | "B2B portál" | "API integrace" | "Telefon / Manuální";
    lastCatalogSync: string;
    mappedProductsCount: number;
    contactEmail?: string;
    note?: string;
}

export interface ProductVariantMapping {
    id: string;
    productId: string;
    productName: string;
    variantId: string;
    variantName: string;
    eshopSku: string;
    supplierId: string;
    supplierName: string;
    supplierSku: string;
    purchasePriceCzk: number;
    supplierStock: number;
    leadTimeDays: number;
    priority: number;
    active: boolean;
}

export interface CatalogProductView {
    id: string;
    name: string;
    sku: string;
    category: string;
    ownStock: number;
    variants: {
        variantId: string;
        variantName: string;
        sku: string;
        ownStock: number;
        mappings: ProductVariantMapping[];
    }[];
    openPurchaseOrdersCount: number;
    waitingCustomerOrdersCount: number;
}

export interface ProcurementSettings {
    defaultStrategy: "CHEAPEST" | "FASTEST" | "SPLIT_BALANCED" | "PREFERRED_SUPPLIER";
    preferMainSupplier: boolean;
    allowMultiSupplierSplit: boolean;
    autoApprovalThresholdCzk: number;
    minSafetyStockDays: number;
    reorderRounding: "EXACT" | "PACKAGE_ROUNDING";
}

export interface ManualInterventionRecord {
    id: string;
    targetType: "PURCHASE_ORDER" | "SUPPLIER_SELECTION" | "ORDER_QUANTITY" | "GOODS_RECEIPT" | "ALLOCATION";
    targetId: string;
    orderId?: string;
    originalValue: string;
    newValue: string;
    reason: string;
    user: string;
    timestamp: string;
}

export class SupplierMappingService {
    private suppliers: Map<string, SupplierConfig> = new Map();
    private mappings: ProductVariantMapping[] = [];
    private auditRecords: ManualInterventionRecord[] = [];
    private settings: ProcurementSettings = {
        defaultStrategy: "SPLIT_BALANCED",
        preferMainSupplier: true,
        allowMultiSupplierSplit: true,
        autoApprovalThresholdCzk: 10000,
        minSafetyStockDays: 3,
        reorderRounding: "EXACT",
    };

    constructor() {
        this.seedInitialData();
    }

    private seedInitialData(): void {
        this.addSupplier({
            id: "SUP-FOX",
            name: "Fox Outdoor",
            status: "ACTIVE",
            statusLabel: "Aktivní partner",
            categoryDescription: "Textil, outdoorové vybavení, funkční prádlo",
            priority: 1,
            leadTimeDays: 1,
            leadTimeLabel: "1-2 pracovní dny",
            minOrderAmountCzk: 0,
            minOrderLabel: "Bez minimálního limitu",
            orderMethod: "E-mail s tabulkou",
            lastCatalogSync: "Dnes v 08:30 (automaticky)",
            mappedProductsCount: 142,
            contactEmail: "objednavky@foxoutdoor.cz",
            note: "Hlavní partner pro trička a základní textil s nejkratší dodací lhůtou.",
        });

        this.addSupplier({
            id: "SUP-HELIKON",
            name: "Helikon-Tex",
            status: "ACTIVE",
            statusLabel: "Aktivní partner",
            categoryDescription: "Zdravotnický materiál, taktická výstroj, obinadla",
            priority: 2,
            leadTimeDays: 2,
            leadTimeLabel: "2-3 pracovní dny",
            minOrderAmountCzk: 500,
            minOrderLabel: "500 Kč",
            orderMethod: "B2B portál",
            lastCatalogSync: "Dnes v 09:15 (automaticky)",
            mappedProductsCount: 88,
            contactEmail: "b2b@helikon-tex.com",
            note: "Specialista na zdravotnický a taktický sortiment.",
        });

        this.addSupplier({
            id: "SUP-BRANDIT",
            name: "Brandit CZ",
            status: "ACTIVE",
            statusLabel: "Záložní partner",
            categoryDescription: "Bundy M65, batohy, záložní textil a obuv",
            priority: 3,
            leadTimeDays: 3,
            leadTimeLabel: "3-4 pracovní dny",
            minOrderAmountCzk: 1000,
            minOrderLabel: "1 000 Kč",
            orderMethod: "E-mail s tabulkou",
            lastCatalogSync: "Včera v 18:00",
            mappedProductsCount: 65,
            contactEmail: "velkoobchod@brandit.cz",
            note: "Záložní dodavatel při vyčerpání zásob u hlavních partnerů.",
        });

        this.addMapping({
            id: "MAP-001",
            productId: "PROD-TRIKO-BASIC",
            productName: "Čistý triko Basic",
            variantId: "VAR-BLK-M",
            variantName: "Černá / M",
            eshopSku: "TRIKO-BASIC-BLK-M",
            supplierId: "SUP-FOX",
            supplierName: "Fox Outdoor",
            supplierSku: "FOX-TSHIRT-BLK-M",
            purchasePriceCzk: 120,
            supplierStock: 45,
            leadTimeDays: 1,
            priority: 1,
            active: true,
        });

        this.addMapping({
            id: "MAP-002",
            productId: "PROD-TRIKO-BASIC",
            productName: "Čistý triko Basic",
            variantId: "VAR-BLK-M",
            variantName: "Černá / M",
            eshopSku: "TRIKO-BASIC-BLK-M",
            supplierId: "SUP-BRANDIT",
            supplierName: "Brandit CZ",
            supplierSku: "BR-BASIC-BLK-M",
            purchasePriceCzk: 135,
            supplierStock: 20,
            leadTimeDays: 3,
            priority: 2,
            active: true,
        });

        this.addMapping({
            id: "MAP-003",
            productId: "PROD-OBINADLO",
            productName: "Elastické obinadlo 10cm",
            variantId: "VAR-10CM-DEFAULT",
            variantName: "10cm × 5m",
            eshopSku: "MED-BANDAGE-10CM",
            supplierId: "SUP-HELIKON",
            supplierName: "Helikon-Tex",
            supplierSku: "HEL-MED-BAND-10",
            purchasePriceCzk: 45,
            supplierStock: 4,
            leadTimeDays: 2,
            priority: 1,
            active: true,
        });

        this.addMapping({
            id: "MAP-004",
            productId: "PROD-OBINADLO",
            productName: "Elastické obinadlo 10cm",
            variantId: "VAR-10CM-DEFAULT",
            variantName: "10cm × 5m",
            eshopSku: "MED-BANDAGE-10CM",
            supplierId: "SUP-BRANDIT",
            supplierName: "Brandit CZ",
            supplierSku: "BR-ELAST-BAND-10",
            purchasePriceCzk: 52,
            supplierStock: 25,
            leadTimeDays: 3,
            priority: 2,
            active: true,
        });
    }

    public getSuppliers(): SupplierConfig[] {
        return Array.from(this.suppliers.values());
    }

    public getSupplier(id: string): SupplierConfig | undefined {
        return this.suppliers.get(id);
    }

    public addSupplier(supplier: SupplierConfig): SupplierConfig {
        this.suppliers.set(supplier.id, supplier);
        return supplier;
    }

    public updateSupplier(id: string, update: Partial<SupplierConfig>): SupplierConfig {
        const existing = this.suppliers.get(id);
        if (!existing) throw new Error("Dodavatel nebyl nalezen");
        const updated = { ...existing, ...update };
        this.suppliers.set(id, updated);
        return updated;
    }

    public getMappingsForVariant(eshopSku: string): ProductVariantMapping[] {
        return this.mappings
            .filter((m) => m.eshopSku === eshopSku && m.active)
            .sort((a, b) => a.priority - b.priority);
    }

    public getAllMappings(): ProductVariantMapping[] {
        return [...this.mappings];
    }

    public addMapping(mapping: ProductVariantMapping): ProductVariantMapping {
        this.mappings.push(mapping);
        const sup = this.suppliers.get(mapping.supplierId);
        if (sup) {
            sup.mappedProductsCount = this.mappings.filter((m) => m.supplierId === mapping.supplierId).length;
        }
        return mapping;
    }

    public updateMapping(id: string, update: Partial<ProductVariantMapping>): ProductVariantMapping {
        const idx = this.mappings.findIndex((m) => m.id === id);
        if (idx === -1) throw new Error("Mapovani neexistuje");
        const merged: ProductVariantMapping = { ...this.mappings[idx], ...update } as ProductVariantMapping;
        this.mappings[idx] = merged;
        return this.mappings[idx]!;
    }

    public removeMapping(id: string): void {
        this.mappings = this.mappings.filter((m) => m.id !== id);
    }

    public recordIntervention(intervention: Omit<ManualInterventionRecord, "id" | "timestamp">): ManualInterventionRecord {
        const record: ManualInterventionRecord = {
            ...intervention,
            id: `AUDIT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            timestamp: new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }),
        };
        this.auditRecords.unshift(record);
        return record;
    }

    public getAuditTrail(): ManualInterventionRecord[] {
        return [...this.auditRecords];
    }

    public getSettings(): ProcurementSettings {
        return { ...this.settings };
    }

    public updateSettings(newSettings: Partial<ProcurementSettings>): ProcurementSettings {
        this.settings = { ...this.settings, ...newSettings };
        return { ...this.settings };
    }
}
