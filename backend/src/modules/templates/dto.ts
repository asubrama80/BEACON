export type TemplateChannel = "sms" | "email";

/** List view — omits `body` per the module spec's "return summary DTOs where practical". */
export interface TemplateSummaryDto {
  id: string;
  name: string;
  channel: TemplateChannel;
  subject: string | null;
  status: string;
  placeholders: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDetailDto extends TemplateSummaryDto {
  body: string;
}

export interface TemplateRow {
  id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function detectPlaceholdersForDisplay(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

export function toTemplateSummaryDto(row: TemplateRow): TemplateSummaryDto {
  const placeholders = new Set(detectPlaceholdersForDisplay(row.body));
  if (row.subject) for (const p of detectPlaceholdersForDisplay(row.subject)) placeholders.add(p);
  return {
    id: row.id,
    name: row.name,
    channel: row.channel as TemplateChannel,
    subject: row.subject,
    status: row.status,
    placeholders: [...placeholders],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTemplateDetailDto(row: TemplateRow): TemplateDetailDto {
  return { ...toTemplateSummaryDto(row), body: row.body };
}
