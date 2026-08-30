/**
 * The single, authoritative list of placeholders Template content may reference. Centralized
 * here (never duplicated in the frontend, which only mirrors it for a picker UI) so a future
 * Alert module's rendering context and this module's own preview always agree on exactly what
 * "{{firstName}}" means.
 */
export interface PlaceholderDefinition {
  key: string;
  label: string;
  /** Where a future Alert-rendering context would resolve this value from. */
  source: "contact";
  /** Used only for this module's safe, synthetic preview — never real Contact data. */
  sampleValue: string;
}

export const PLACEHOLDER_REGISTRY: readonly PlaceholderDefinition[] = [
  { key: "firstName", label: "First Name", source: "contact", sampleValue: "Alex" },
  { key: "lastName", label: "Last Name", source: "contact", sampleValue: "Morgan" },
  { key: "displayName", label: "Display Name", source: "contact", sampleValue: "Alex Morgan" },
] as const;

export const ALLOWED_PLACEHOLDER_KEYS: ReadonlySet<string> = new Set(
  PLACEHOLDER_REGISTRY.map((p) => p.key),
);

export function samplePlaceholderValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const p of PLACEHOLDER_REGISTRY) values[p.key] = p.sampleValue;
  return values;
}
