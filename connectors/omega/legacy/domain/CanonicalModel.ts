import { Decimal } from 'decimal.js';

export type TenantId = string;
export type ShopId = string;
export type DocumentId = string;

export interface Money {
  amount: Decimal;
  currency: string;
}

export interface Tax {
  rate: number; // e.g., 20 for 20%
  amount: Money;
}

export interface Address {
  street: string;
  city: string;
  zipCode: string;
  country: string;
}

export interface Customer {
  id: string;
  isCompany: boolean;
  name: string;
  companyName?: string;
  ico?: string;
  dic?: string;
  icDph?: string;
  email: string;
  phone?: string;
  billingAddress: Address;
  shippingAddress?: Address;
}

export interface OrderItem {
  id: string;
  sku: string;
  name: string;
  quantity: Decimal;
  unitPriceWithoutTax: Money;
  tax: Tax;
  unitPriceWithTax: Money;
  totalPriceWithTax: Money;
}

export interface Shipping {
  id: string;
  name: string;
  priceWithoutTax: Money;
  tax: Tax;
  priceWithTax: Money;
}

export interface Payment {
  id: string;
  name: string;
  priceWithoutTax: Money;
  tax: Tax;
  priceWithTax: Money;
}

export interface Discount {
  id: string;
  name: string;
  amountWithTax: Money; // Will be mapped to a negative line item in OMEGA
}

export interface CanonicalOrder {
  tenantId: TenantId;
  shopId: ShopId;
  orderNumber: string;
  createdAt: Date;
  customer: Customer;
  items: OrderItem[];
  shipping: Shipping;
  payment: Payment;
  discounts: Discount[];
  totalAmount: Money;
  note?: string;
}
