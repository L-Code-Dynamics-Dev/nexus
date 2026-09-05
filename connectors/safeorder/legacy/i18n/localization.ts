import { SupportedCurrency, SupportedLanguage } from '../core/types.js';

export interface LocalizedExplanation {
  headline: string;
  summary: string;
  reasons: string[];
  actionAdvice: string;
}

const REASON_DICTIONARY: Record<SupportedLanguage, Record<string, string>> = {
  en: {
    UNCOLLECTED_SHIPMENT_DETECTED: 'Previous uncollected shipment detected for this customer identity.',
    REPEATED_RETURN_HISTORY: 'High frequency of customer return requests detected.',
    MERCHANT_MANUAL_FLAG: 'Merchant flagged customer identity as high risk.',
    PREVIOUS_FALSE_POSITIVE_ADJUSTMENT: 'Risk reduced due to verified previous successful delivery override.',
    NETWORK_REPUTATION_FLAG: 'Adverse risk pattern detected across cross-store reputation network.',
    HIGH_ORDER_VALUE_SURGE: 'Order value significantly exceeds merchant average.',
    FREQUENT_REPEAT_ORDERS: 'Unusual spike in order velocity within short timeframe.',
    NO_ADVERSE_SIGNALS: 'No adverse risk signals found. Standard order profile.'
  },
  cs: {
    UNCOLLECTED_SHIPMENT_DETECTED: 'Zjištěna předchozí nepřevzatá zásilka na dobírku.',
    REPEATED_RETURN_HISTORY: 'Zaznamenán zvýšený počet vráceného zboží od zákazníka.',
    MERCHANT_MANUAL_FLAG: 'Manuální označení zákazníka obchodníkem jako rizikového.',
    PREVIOUS_FALSE_POSITIVE_ADJUSTMENT: 'Riziko sníženo na základě úspěšného předchozího doručení.',
    NETWORK_REPUTATION_FLAG: 'Zaznamenán negativní signál v rámci reputační sítě e-shopů.',
    HIGH_ORDER_VALUE_SURGE: 'Výrazně vyšší hodnota objednávky oproti průměru obchodu.',
    FREQUENT_REPEAT_ORDERS: 'Vysoká frekvence opakovaných objednávek v krátkém čase.',
    NO_ADVERSE_SIGNALS: 'Nenalezeny žádné negativní signály. Běžná objednávka.'
  },
  de: {
    UNCOLLECTED_SHIPMENT_DETECTED: 'Vorherige unzustellbare Nachnahmesendung für diesen Kunden festgestellt.',
    REPEATED_RETURN_HISTORY: 'Erhöhte Häufigkeit von Warenrücksendungen festgestellt.',
    MERCHANT_MANUAL_FLAG: 'Kunde vom Händler manuell als risikoreich markiert.',
    PREVIOUS_FALSE_POSITIVE_ADJUSTMENT: 'Risiko aufgrund erfolgreicher Zustellungen reduziert.',
    NETWORK_REPUTATION_FLAG: 'Negatives Risikosignal im Händlernetzwerk festgestellt.',
    HIGH_ORDER_VALUE_SURGE: 'Bestellwert liegt deutlich über dem Händlerdurchschnitt.',
    FREQUENT_REPEAT_ORDERS: 'Ungewöhnlich hohe Bestellhäufigkeit in kurzem Zeitraum.',
    NO_ADVERSE_SIGNALS: 'Keine negativen Risikosignale gefunden. Standardbestellung.'
  },
  pl: {
    UNCOLLECTED_SHIPMENT_DETECTED: 'Wykryto wcześniejszą nieodebraną przesyłkę za pobraniem.',
    REPEATED_RETURN_HISTORY: 'Wykryto podwyższoną liczbę zwrotów od klienta.',
    MERCHANT_MANUAL_FLAG: 'Klient oznaczony ręcznie przez sklep jako podwyższone ryzyko.',
    PREVIOUS_FALSE_POSITIVE_ADJUSTMENT: 'Ryzyko obniżone z powodu udanej weryfikacji dostawy.',
    NETWORK_REPUTATION_FLAG: 'Negatywny sygnał w sieci reputacyjnej sklepów.',
    HIGH_ORDER_VALUE_SURGE: 'Wartość zamówienia znacznie przekracza średnią sklepu.',
    FREQUENT_REPEAT_ORDERS: 'Niezwykle duża liczba zamówień w krótkim czasie.',
    NO_ADVERSE_SIGNALS: 'Brak negatywnych sygnałów ryzyka. Standardowe zamówienie.'
  }
};

export function localizeReasonCodes(reasonCodes: string[], lang: SupportedLanguage = 'en'): string[] {
  const dict = REASON_DICTIONARY[lang] ?? REASON_DICTIONARY.en;
  return reasonCodes.map(code => dict[code] ?? code);
}

export function formatCurrencyAmount(amount: number, currency: SupportedCurrency = 'EUR', lang: SupportedLanguage = 'en'): string {
  const locales: Record<SupportedLanguage, string> = {
    en: 'en-US',
    cs: 'cs-CZ',
    de: 'de-DE',
    pl: 'pl-PL'
  };

  return new Intl.NumberFormat(locales[lang] ?? 'en-US', {
    style: 'currency',
    currency: currency.toUpperCase()
  }).format(amount);
}
