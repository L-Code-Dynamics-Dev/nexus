export type ShoptetDataType = 'string' | 'decimal' | 'boolean' | 'date' | 'integer';

export interface ShoptetColumnDefinition {
  /**
   * The path in the Canonical Model where this data belongs (e.g. "customer.email")
   */
  canonicalField: string;
  
  /**
   * Known header variations in Shoptet export variants
   */
  acceptedSourceNames: string[];
  
  required: boolean;
  
  dataType: ShoptetDataType;
  
  /**
   * Extractor function taking the raw string and converting it safely to target type.
   * If parsing fails, it must throw an Error or return undefined (which triggers required check).
   */
  parser: (raw: string) => any;
  
  /**
   * Validation rules evaluated immediately after parsing
   */
  validationRules?: Array<(value: any) => string | null>;
  
  /**
   * Normalization rules (e.g. trimming, casing, phone prefixing)
   */
  normalizationRules?: Array<(value: any) => any>;
}

export interface ShoptetExportSchema {
  schemaName: string;
  version: string;
  delimiter: string;
  columns: ShoptetColumnDefinition[];
}

// Example Parser Implementations
export const ParseString = (raw: string) => raw ? raw.trim() : '';
export const ParseDecimal = (raw: string) => {
  if (!raw) return undefined;
  // Standardize comma to dot if needed, handle whitespace
  return raw.replace(/\s/g, '').replace(',', '.'); 
};
export const ParseBoolean = (raw: string) => {
  if (!raw) return false;
  const lower = raw.toLowerCase().trim();
  return lower === '1' || lower === 'ano' || lower === 'true' || lower === 'yes';
};
export const ParseDate = (raw: string) => {
  if (!raw) return undefined;
  // Implement robust Shoptet date parsing (often DD.MM.YYYY HH:mm)
  return raw; // Placeholder, real impl must return Date object or valid ISO string
};

export const ShoptetOrderExportSchemaV1: ShoptetExportSchema = {
  schemaName: 'SHOPTET_ORDER_EXPORT',
  version: '1.0',
  delimiter: ';',
  columns: [
    {
      canonicalField: 'orderNumber',
      acceptedSourceNames: ['Kód', 'Kod', 'OrderNumber', 'Číslo objednávky'],
      required: true,
      dataType: 'string',
      parser: ParseString
    },
    {
      canonicalField: 'customer.email',
      acceptedSourceNames: ['Email', 'E-mail', 'Zákazník - e-mail'],
      required: true,
      dataType: 'string',
      parser: ParseString,
      normalizationRules: [(val: string) => val.toLowerCase()]
    },
    {
      canonicalField: 'customer.name',
      acceptedSourceNames: ['Jméno', 'Jméno a příjmení', 'Zákazník'],
      required: true,
      dataType: 'string',
      parser: ParseString
    },
    {
      canonicalField: 'customer.ico',
      acceptedSourceNames: ['IČ', 'IČO', 'Company ID'],
      required: false,
      dataType: 'string',
      parser: ParseString
    },
    {
      canonicalField: 'customer.dic',
      acceptedSourceNames: ['DIČ', 'VAT ID'],
      required: false,
      dataType: 'string',
      parser: ParseString
    },
    {
      canonicalField: 'totalAmount.amount',
      acceptedSourceNames: ['Celková cena', 'Celkem s DPH', 'Total price'],
      required: true,
      dataType: 'decimal',
      parser: ParseDecimal
    },
    {
      canonicalField: 'totalAmount.currency',
      acceptedSourceNames: ['Měna', 'Currency'],
      required: true,
      dataType: 'string',
      parser: ParseString,
      normalizationRules: [(val: string) => val.toUpperCase()]
    },
    {
      canonicalField: 'item.name',
      acceptedSourceNames: ['Název položky', 'Položka', 'Item name'],
      required: true,
      dataType: 'string',
      parser: ParseString
    },
    {
      canonicalField: 'item.quantity',
      acceptedSourceNames: ['Množství', 'Ks', 'Quantity'],
      required: true,
      dataType: 'decimal',
      parser: ParseDecimal
    },
    {
      canonicalField: 'item.unitPriceWithTax.amount',
      acceptedSourceNames: ['Cena za ks', 'Jednotková cena', 'Unit price'],
      required: true,
      dataType: 'decimal',
      parser: ParseDecimal
    }
  ]
};
