import { apiFetch } from "../lib/api";
import type { ApiErrorBody } from "../contacts/types";
import type {
  ColumnMapping,
  ConfirmResponse,
  ImportBatch,
  ImportRowStatus,
  PreviewResponse,
  RowDecision,
  UploadResponse,
} from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export async function uploadImportFile(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.set("file", file, file.name);
  const response = await apiFetch("/contacts/import/upload", { method: "POST", body: form });
  return parseOrThrow<UploadResponse>(response);
}

export async function previewImportBatch(batchId: string, mapping: ColumnMapping): Promise<PreviewResponse> {
  const response = await apiFetch(`/contacts/import/${batchId}/preview`, {
    method: "POST",
    body: JSON.stringify({ mapping }),
  });
  return parseOrThrow<PreviewResponse>(response);
}

export async function getImportBatch(
  batchId: string,
  params: { page?: number; pageSize?: number; status?: ImportRowStatus } = {},
): Promise<PreviewResponse> {
  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));
  if (params.status) query.set("status", params.status);
  const response = await apiFetch(`/contacts/import/${batchId}?${query.toString()}`);
  return parseOrThrow<PreviewResponse>(response);
}

export async function confirmImportBatch(batchId: string, decisions: RowDecision[]): Promise<ConfirmResponse> {
  const response = await apiFetch(`/contacts/import/${batchId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ decisions }),
  });
  return parseOrThrow<ConfirmResponse>(response);
}

export type { ImportBatch };
