import { apiFetch } from "../lib/api";
import type { ApiErrorBody, PreviewResponse, TemplateDetail, TemplatesListResponse } from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export interface CreateTemplateInput {
  name: string;
  channel: "sms" | "email";
  subject?: string;
  body: string;
}

export interface UpdateTemplateInput {
  name?: string;
  subject?: string;
  body?: string;
}

export async function listTemplates(params: {
  search?: string;
  channel?: string;
  status?: string;
  page?: number;
}): Promise<TemplatesListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.channel) query.set("channel", params.channel);
  if (params.status) query.set("status", params.status);
  if (params.page) query.set("page", String(params.page));

  const response = await apiFetch(`/templates?${query.toString()}`);
  return parseOrThrow<TemplatesListResponse>(response);
}

export async function getTemplate(id: string): Promise<TemplateDetail> {
  const response = await apiFetch(`/templates/${id}`);
  const body = await parseOrThrow<{ template: TemplateDetail }>(response);
  return body.template;
}

export async function createTemplate(input: CreateTemplateInput): Promise<TemplateDetail> {
  const response = await apiFetch("/templates", { method: "POST", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ template: TemplateDetail }>(response);
  return body.template;
}

export async function updateTemplate(id: string, input: UpdateTemplateInput): Promise<TemplateDetail> {
  const response = await apiFetch(`/templates/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ template: TemplateDetail }>(response);
  return body.template;
}

export async function disableTemplate(id: string): Promise<TemplateDetail> {
  const response = await apiFetch(`/templates/${id}/disable`, { method: "POST" });
  const body = await parseOrThrow<{ template: TemplateDetail }>(response);
  return body.template;
}

export async function enableTemplate(id: string): Promise<TemplateDetail> {
  const response = await apiFetch(`/templates/${id}/enable`, { method: "POST" });
  const body = await parseOrThrow<{ template: TemplateDetail }>(response);
  return body.template;
}

export async function previewTemplate(
  input: { templateId: string } | { channel: "sms" | "email"; subject?: string; body: string },
): Promise<PreviewResponse> {
  const response = await apiFetch("/templates/preview", { method: "POST", body: JSON.stringify(input) });
  return parseOrThrow<PreviewResponse>(response);
}
