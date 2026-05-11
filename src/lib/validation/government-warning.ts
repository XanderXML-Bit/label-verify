// Government Warning validator. The strictest field — implementation in Phase 5.
// Federal regulation: 27 CFR § 16.21.

export const GOVERNMENT_WARNING_PREFIX = "GOVERNMENT WARNING:";

export const GOVERNMENT_WARNING_BODY =
  "(1) According to the Surgeon General, women should not drink alcoholic beverages " +
  "during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic " +
  "beverages impairs your ability to drive a car or operate machinery, and may cause " +
  "health problems.";

export interface GovernmentWarningCheck {
  textMatches: boolean;
  prefixCaps: boolean;
  prefixBold: boolean;
  pass: boolean;
  reason?: string;
}
