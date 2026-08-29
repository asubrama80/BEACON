import type { RowDecision } from "./types";

export function decisionsToPayload(decisions: Map<string, { selected: boolean; confirmDuplicate: boolean }>): RowDecision[] {
  return [...decisions.entries()].map(([rowId, d]) => ({
    rowId,
    selected: d.selected,
    confirmDuplicate: d.confirmDuplicate,
  }));
}
