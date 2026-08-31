import { apiFetch } from "../lib/api";
import type { AdminStatus, ApiErrorBody, RoleSummary } from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export async function getAdminStatus(): Promise<AdminStatus> {
  const response = await apiFetch("/admin/status");
  return parseOrThrow<AdminStatus>(response);
}

export async function listRoleSummaries(): Promise<RoleSummary[]> {
  const response = await apiFetch("/admin/roles");
  const body = await parseOrThrow<{ items: RoleSummary[] }>(response);
  return body.items;
}

export async function revokeUserSessionsAdmin(userId: string): Promise<void> {
  const response = await apiFetch(`/admin/users/${userId}/sessions/revoke`, { method: "POST" });
  await parseOrThrow<{ success: boolean }>(response);
}

export async function resetUserMfaAdmin(userId: string): Promise<void> {
  const response = await apiFetch(`/admin/users/${userId}/mfa/reset`, { method: "POST" });
  await parseOrThrow<{ success: boolean }>(response);
}
