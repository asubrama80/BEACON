import { apiFetch } from "../lib/api";
import type { ApiErrorBody, RoleRef, UserDetail, UsersListResponse } from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export async function listUsers(params: {
  search?: string;
  status?: string;
  roleCode?: string;
  page?: number;
}): Promise<UsersListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.status) query.set("status", params.status);
  if (params.roleCode) query.set("roleCode", params.roleCode);
  if (params.page) query.set("page", String(params.page));

  const response = await apiFetch(`/users?${query.toString()}`);
  return parseOrThrow<UsersListResponse>(response);
}

export async function getUser(id: string): Promise<UserDetail> {
  const response = await apiFetch(`/users/${id}`);
  const body = await parseOrThrow<{ user: UserDetail }>(response);
  return body.user;
}

export async function createUser(input: {
  email: string;
  displayName: string;
  initialPassword: string;
  roleCodes: string[];
}): Promise<UserDetail> {
  const response = await apiFetch("/users", { method: "POST", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ user: UserDetail }>(response);
  return body.user;
}

export async function updateUser(id: string, input: { email?: string; displayName?: string }): Promise<UserDetail> {
  const response = await apiFetch(`/users/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ user: UserDetail }>(response);
  return body.user;
}

export async function disableUser(id: string): Promise<UserDetail> {
  const response = await apiFetch(`/users/${id}/disable`, { method: "POST" });
  const body = await parseOrThrow<{ user: UserDetail }>(response);
  return body.user;
}

export async function enableUser(id: string): Promise<UserDetail> {
  const response = await apiFetch(`/users/${id}/enable`, { method: "POST" });
  const body = await parseOrThrow<{ user: UserDetail }>(response);
  return body.user;
}

export async function assignRole(id: string, roleCode: string): Promise<UserDetail> {
  const response = await apiFetch(`/users/${id}/roles`, { method: "POST", body: JSON.stringify({ roleCode }) });
  const body = await parseOrThrow<{ user: UserDetail }>(response);
  return body.user;
}

export async function removeRole(id: string, roleCode: string): Promise<UserDetail> {
  const response = await apiFetch(`/users/${id}/roles/${roleCode}`, { method: "DELETE" });
  const body = await parseOrThrow<{ user: UserDetail }>(response);
  return body.user;
}

export async function resetPassword(id: string, newPassword: string): Promise<void> {
  const response = await apiFetch(`/users/${id}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ newPassword }),
  });
  await parseOrThrow<{ success: boolean }>(response);
}

export async function listRoles(): Promise<RoleRef[]> {
  const response = await apiFetch("/roles");
  const body = await parseOrThrow<{ roles: RoleRef[] }>(response);
  return body.roles;
}
