/**
 * UI-convenience mirror of the placeholder picker labels only — the backend registry
 * (backend/src/modules/templates/placeholders.ts) remains the sole source of truth for what's
 * actually accepted; this list must be kept in sync with it but the frontend never invents or
 * validates placeholders on its own.
 */
export const PLACEHOLDER_PICKER: { key: string; label: string; token: string }[] = [
  { key: "firstName", label: "First Name", token: "{{firstName}}" },
  { key: "lastName", label: "Last Name", token: "{{lastName}}" },
  { key: "displayName", label: "Display Name", token: "{{displayName}}" },
];
