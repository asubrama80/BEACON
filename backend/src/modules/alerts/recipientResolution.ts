import type { DbOrTx } from "@beacon/database";
import { findGroupById, getGroupMemberContactIds } from "../groups/groupQueries.js";
import { findContactsByIds } from "../contacts/contactQueries.js";
import type { ContactRow } from "../contacts/dto.js";
import type { AlertChannel } from "./dto.js";

export type ExclusionReason = "inactive" | "missing_channel";

export interface ExcludedContact {
  contactId: string;
  displayName: string;
  reason: ExclusionReason;
}

export interface ResolvedRecipients {
  /** Eligible Contacts only — active, with the required destination for the Alert's channel. */
  eligible: ContactRow[];
  excluded: ExcludedContact[];
  exclusionSummary: Record<ExclusionReason, number>;
  /** How many raw selection references (direct + group-expanded) collapsed into unique Contacts. */
  duplicatesCollapsedCount: number;
  /** Selected Group ids that are missing or inactive — never silently ignored. */
  invalidGroupIds: string[];
}

function destinationFor(contact: ContactRow, channel: AlertChannel): string | null {
  return channel === "sms" ? contact.mobilePhone : contact.email;
}

/**
 * Server-authoritative recipient resolution: direct Contact selections + Group-expanded
 * selections, deduplicated by Contact identity (never by shared email/phone — see module doc,
 * "Group expansion/deduplication"), then classified as eligible or excluded. Reused identically
 * by both the preview endpoint and the READY transaction, so an operator's preview and the
 * actual READY snapshot can never disagree.
 */
export async function resolveRecipients(
  db: DbOrTx,
  input: { contactIds: string[]; groupIds: string[]; channel: AlertChannel },
): Promise<ResolvedRecipients> {
  const invalidGroupIds: string[] = [];
  const groupExpandedIds: string[] = [];

  for (const groupId of input.groupIds) {
    const group = await findGroupById(db, groupId);
    if (!group || group.status !== "active") {
      invalidGroupIds.push(groupId);
      continue;
    }
    const memberIds = await getGroupMemberContactIds(db, groupId);
    groupExpandedIds.push(...memberIds);
  }

  const allSelectedIds = [...input.contactIds, ...groupExpandedIds];
  const uniqueIds = [...new Set(allSelectedIds)];
  const duplicatesCollapsedCount = allSelectedIds.length - uniqueIds.length;

  const contactRows = await findContactsByIds(db, uniqueIds);
  const contactById = new Map(contactRows.map((c) => [c.id, c]));

  const eligible: ContactRow[] = [];
  const excluded: ExcludedContact[] = [];
  const exclusionSummary: Record<ExclusionReason, number> = { inactive: 0, missing_channel: 0 };

  for (const id of uniqueIds) {
    const contact = contactById.get(id);
    if (!contact) continue; // Selection referenced a Contact that no longer exists — silently dropped, never invented.

    const displayName = `${contact.firstName} ${contact.lastName}`.trim();
    if (contact.status !== "active") {
      excluded.push({ contactId: id, displayName, reason: "inactive" });
      exclusionSummary.inactive += 1;
      continue;
    }
    if (!destinationFor(contact, input.channel)) {
      excluded.push({ contactId: id, displayName, reason: "missing_channel" });
      exclusionSummary.missing_channel += 1;
      continue;
    }
    eligible.push(contact);
  }

  return { eligible, excluded, exclusionSummary, duplicatesCollapsedCount, invalidGroupIds };
}
