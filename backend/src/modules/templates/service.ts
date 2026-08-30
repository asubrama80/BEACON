import { eq } from "drizzle-orm";
import { templates, type Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { recordAuthEvent } from "../auth/audit.js";
import {
  findTemplateById,
  findTemplateByNameAndChannel,
  listTemplates as queryTemplates,
  normalizePagination,
  type ListTemplatesFilter,
} from "./templateQueries.js";
import { toTemplateDetailDto, toTemplateSummaryDto, type TemplateChannel, type TemplateDetailDto, type TemplateSummaryDto } from "./dto.js";
import { renderTemplate, validateTemplateContent } from "./rendering.js";
import { samplePlaceholderValues } from "./placeholders.js";
import { estimateSmsSegments, type SmsSegmentEstimate } from "./smsSegments.js";

const NAME_MAX_LENGTH = 255;
const SUBJECT_MAX_LENGTH = 255;
const BODY_MAX_LENGTH = 5000;
const CHANNELS: readonly TemplateChannel[] = ["sms", "email"];

function validateName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AuthError(400, "invalid_request", "Template name is required.");
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    throw new AuthError(400, "invalid_request", `Template name must be ${NAME_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function validateChannel(value: string): TemplateChannel {
  if (!CHANNELS.includes(value as TemplateChannel)) {
    throw new AuthError(400, "invalid_request", `Channel must be one of: ${CHANNELS.join(", ")}.`);
  }
  return value as TemplateChannel;
}

function validateBody(value: string): string {
  if (!value || !value.trim()) {
    throw new AuthError(400, "invalid_request", "Message body is required.");
  }
  if (value.length > BODY_MAX_LENGTH) {
    throw new AuthError(400, "invalid_request", `Message body must be ${BODY_MAX_LENGTH} characters or fewer.`);
  }
  return value;
}

/** Enforces the channel-specific subject rule: SMS never has one, Email always requires one. */
function validateSubjectForChannel(channel: TemplateChannel, subject: string | undefined): string | null {
  if (channel === "sms") {
    if (subject !== undefined && subject.trim().length > 0) {
      throw new AuthError(400, "invalid_request", "SMS templates do not use a subject.");
    }
    return null;
  }
  const trimmed = (subject ?? "").trim();
  if (!trimmed) {
    throw new AuthError(400, "invalid_request", "Email templates require a subject.");
  }
  if (trimmed.length > SUBJECT_MAX_LENGTH) {
    throw new AuthError(400, "invalid_request", `Subject must be ${SUBJECT_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function assertContentIsInert(text: string, label: string): void {
  const result = validateTemplateContent(text);
  if (!result.valid) {
    throw new AuthError(400, "invalid_request", `${label}: ${result.errors.join(" ")}`);
  }
}

async function assertNameAvailable(
  db: Database,
  name: string,
  channel: TemplateChannel,
  excludeId?: string,
): Promise<void> {
  const existing = await findTemplateByNameAndChannel(db, name, channel, excludeId);
  if (existing) {
    throw new AuthError(409, "duplicate_template_name", "A template with this name and channel already exists.");
  }
}

async function loadDto(db: Database, id: string): Promise<TemplateDetailDto> {
  const row = await findTemplateById(db, id);
  if (!row) {
    throw new AuthError(404, "not_found", "Template not found.");
  }
  return toTemplateDetailDto(row);
}

export interface ListTemplatesOptions {
  search?: string;
  channel?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface ListTemplatesResponse {
  items: TemplateSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listTemplates(db: Database, options: ListTemplatesOptions): Promise<ListTemplatesResponse> {
  const { page, pageSize } = normalizePagination(options.page, options.pageSize);
  const filter: ListTemplatesFilter = { ...options, page, pageSize };
  const result = await queryTemplates(db, filter);
  return { items: result.items.map(toTemplateSummaryDto), total: result.total, page, pageSize };
}

export async function getTemplate(db: Database, id: string): Promise<TemplateDetailDto> {
  return loadDto(db, id);
}

export interface CreateTemplateInput {
  name: string;
  channel: string;
  subject?: string;
  body: string;
}

export async function createTemplate(
  db: Database,
  input: CreateTemplateInput,
  actorId: string,
): Promise<TemplateDetailDto> {
  const name = validateName(input.name);
  const channel = validateChannel(input.channel);
  const body = validateBody(input.body);
  const subject = validateSubjectForChannel(channel, input.subject);

  assertContentIsInert(body, "Message body");
  if (subject) assertContentIsInert(subject, "Subject");

  await assertNameAvailable(db, name, channel);

  const [created] = await db
    .insert(templates)
    .values({ name, channel, subject, body })
    .returning({ id: templates.id });
  if (!created) {
    throw new AuthError(500, "not_found", "Template creation failed unexpectedly.");
  }

  await recordAuthEvent(db, {
    eventType: "TEMPLATE_CREATED",
    actorId,
    resourceType: "template",
    resourceId: created.id,
    metadata: { name, channel },
  });

  return loadDto(db, created.id);
}

export interface UpdateTemplateInput {
  name?: string;
  subject?: string;
  body?: string;
}

export async function updateTemplate(
  db: Database,
  id: string,
  input: UpdateTemplateInput,
  actorId: string,
): Promise<TemplateDetailDto> {
  const current = await findTemplateById(db, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Template not found.");
  }
  const channel = current.channel as TemplateChannel;

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const changedFields: string[] = [];

  if (input.name !== undefined) {
    const name = validateName(input.name);
    if (name.toLowerCase() !== current.name.toLowerCase()) {
      await assertNameAvailable(db, name, channel, id);
    }
    patch.name = name;
    changedFields.push("name");
  }
  if (input.body !== undefined) {
    const body = validateBody(input.body);
    assertContentIsInert(body, "Message body");
    patch.body = body;
    changedFields.push("body");
  }
  if (input.subject !== undefined) {
    const subject = validateSubjectForChannel(channel, input.subject);
    if (subject) assertContentIsInert(subject, "Subject");
    patch.subject = subject;
    changedFields.push("subject");
  }

  if (changedFields.length > 0) {
    await db.update(templates).set(patch).where(eq(templates.id, id));

    await recordAuthEvent(db, {
      eventType: "TEMPLATE_UPDATED",
      actorId,
      resourceType: "template",
      resourceId: id,
      metadata: { fields: changedFields },
    });
  }

  return loadDto(db, id);
}

export async function disableTemplate(db: Database, id: string, actorId: string): Promise<TemplateDetailDto> {
  const current = await findTemplateById(db, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Template not found.");
  }

  await db.update(templates).set({ status: "inactive", updatedAt: new Date() }).where(eq(templates.id, id));

  await recordAuthEvent(db, { eventType: "TEMPLATE_DISABLED", actorId, resourceType: "template", resourceId: id });

  return loadDto(db, id);
}

export async function enableTemplate(db: Database, id: string, actorId: string): Promise<TemplateDetailDto> {
  const current = await findTemplateById(db, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Template not found.");
  }

  await db.update(templates).set({ status: "active", updatedAt: new Date() }).where(eq(templates.id, id));

  await recordAuthEvent(db, { eventType: "TEMPLATE_ENABLED", actorId, resourceType: "template", resourceId: id });

  return loadDto(db, id);
}

export interface PreviewInput {
  templateId?: string;
  channel?: string;
  subject?: string;
  body?: string;
}

export interface PreviewResponse {
  channel: TemplateChannel;
  renderedSubject?: string;
  renderedBody: string;
  unresolvedPlaceholders: string[];
  sms?: SmsSegmentEstimate;
}

/**
 * Renders sample-value preview content — never touches a Contact, never creates anything, and
 * (whether previewing an existing Template by id or ad-hoc unsaved draft content) always
 * re-validates that the content is inert allowlisted-placeholder text, exactly like create/update.
 */
export async function previewTemplate(db: Database, input: PreviewInput): Promise<PreviewResponse> {
  let channel: TemplateChannel;
  let subject: string | undefined;
  let body: string;

  if (input.templateId) {
    const template = await findTemplateById(db, input.templateId);
    if (!template) {
      throw new AuthError(404, "not_found", "Template not found.");
    }
    channel = template.channel as TemplateChannel;
    subject = template.subject ?? undefined;
    body = template.body;
  } else {
    channel = validateChannel(input.channel ?? "");
    body = validateBody(input.body ?? "");
    subject = validateSubjectForChannel(channel, input.subject) ?? undefined;
    assertContentIsInert(body, "Message body");
    if (subject) assertContentIsInert(subject, "Subject");
  }

  const rendered = renderTemplate({ subject, body, values: samplePlaceholderValues() });

  const response: PreviewResponse = {
    channel,
    renderedBody: rendered.renderedBody,
    unresolvedPlaceholders: rendered.unresolvedPlaceholders,
  };
  if (rendered.renderedSubject !== undefined) response.renderedSubject = rendered.renderedSubject;
  if (channel === "sms") response.sms = estimateSmsSegments(rendered.renderedBody);
  return response;
}
