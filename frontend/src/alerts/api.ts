import { apiFetch } from "../lib/api";
import type {
  AlertDetail,
  AlertPreview,
  AlertRecipient,
  AlertRecipientsListResponse,
  AlertsListResponse,
  ApiErrorBody,
  DeliveryEvent,
  DispatchSummary,
  MockDeliveryStatus,
  ProviderStatus,
} from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export interface CreateAlertInput {
  title: string;
  incidentId?: string;
  channel: "sms" | "email";
  contentSource: "template" | "adhoc";
  templateId?: string;
  subject?: string;
  body?: string;
  contactIds?: string[];
  groupIds?: string[];
}

export interface UpdateAlertInput {
  title?: string;
  incidentId?: string | null;
  channel?: "sms" | "email";
  contentSource?: "template" | "adhoc";
  templateId?: string | null;
  subject?: string;
  body?: string;
  contactIds?: string[];
  groupIds?: string[];
}

export async function listAlerts(params: {
  search?: string;
  status?: string;
  channel?: string;
  incidentId?: string;
  /** Module 21 — Alert History date-range filter, ISO 8601 strings. */
  from?: string;
  to?: string;
  page?: number;
}): Promise<AlertsListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.status) query.set("status", params.status);
  if (params.channel) query.set("channel", params.channel);
  if (params.incidentId) query.set("incidentId", params.incidentId);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.page) query.set("page", String(params.page));

  const response = await apiFetch(`/alerts?${query.toString()}`);
  return parseOrThrow<AlertsListResponse>(response);
}

export async function getAlert(id: string): Promise<AlertDetail> {
  const response = await apiFetch(`/alerts/${id}`);
  const body = await parseOrThrow<{ alert: AlertDetail }>(response);
  return body.alert;
}

export async function createAlert(input: CreateAlertInput): Promise<AlertDetail> {
  const response = await apiFetch("/alerts", { method: "POST", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ alert: AlertDetail }>(response);
  return body.alert;
}

export async function updateAlert(id: string, input: UpdateAlertInput): Promise<AlertDetail> {
  const response = await apiFetch(`/alerts/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ alert: AlertDetail }>(response);
  return body.alert;
}

export async function previewAlert(id: string): Promise<AlertPreview> {
  const response = await apiFetch(`/alerts/${id}/preview`, { method: "POST" });
  return parseOrThrow<AlertPreview>(response);
}

export async function readyAlert(id: string): Promise<AlertDetail> {
  const response = await apiFetch(`/alerts/${id}/ready`, { method: "POST" });
  const body = await parseOrThrow<{ alert: AlertDetail }>(response);
  return body.alert;
}

export async function cancelAlert(id: string): Promise<AlertDetail> {
  const response = await apiFetch(`/alerts/${id}/cancel`, { method: "POST" });
  const body = await parseOrThrow<{ alert: AlertDetail }>(response);
  return body.alert;
}

export async function listAlertRecipients(
  id: string,
  params: { page?: number; pageSize?: number } = {},
): Promise<AlertRecipientsListResponse> {
  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));
  const response = await apiFetch(`/alerts/${id}/recipients?${query.toString()}`);
  return parseOrThrow<AlertRecipientsListResponse>(response);
}

export async function dispatchAlert(id: string): Promise<DispatchSummary> {
  const response = await apiFetch(`/alerts/${id}/dispatch`, { method: "POST" });
  return parseOrThrow<DispatchSummary>(response);
}

export async function getProviderStatus(): Promise<ProviderStatus> {
  const response = await apiFetch("/alerts/provider-status");
  return parseOrThrow<ProviderStatus>(response);
}

/** Requires both alerts.recipients.read and alerts.delivery.read — see module doc, "Permissions". */
export async function listRecipientDeliveryEvents(alertId: string, recipientId: string): Promise<DeliveryEvent[]> {
  const response = await apiFetch(`/alerts/${alertId}/recipients/${recipientId}/delivery-events`);
  const body = await parseOrThrow<{ items: DeliveryEvent[] }>(response);
  return body.items;
}

/**
 * Development/test-only delivery-outcome simulation — the route itself is not registered outside
 * development/test (a production backend returns 404). See module doc, "Mock delivery simulation".
 */
export async function simulateMockDelivery(
  alertId: string,
  recipientId: string,
  input: { status: MockDeliveryStatus; errorCode?: string; safeErrorSummary?: string },
): Promise<AlertRecipient> {
  const response = await apiFetch(`/alerts/${alertId}/recipients/${recipientId}/mock-delivery`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  const body = await parseOrThrow<{ recipient: AlertRecipient }>(response);
  return body.recipient;
}
