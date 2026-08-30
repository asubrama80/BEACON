import { apiFetch } from "../lib/api";
import type {
  AddMembersResult,
  ApiErrorBody,
  Group,
  GroupMembersListResponse,
  GroupsListResponse,
} from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export interface GroupInput {
  name: string;
  description?: string;
}

export async function listGroups(params: { search?: string; status?: string; page?: number }): Promise<GroupsListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.status) query.set("status", params.status);
  if (params.page) query.set("page", String(params.page));

  const response = await apiFetch(`/groups?${query.toString()}`);
  return parseOrThrow<GroupsListResponse>(response);
}

export async function getGroup(id: string): Promise<Group> {
  const response = await apiFetch(`/groups/${id}`);
  const body = await parseOrThrow<{ group: Group }>(response);
  return body.group;
}

export async function createGroup(input: GroupInput): Promise<Group> {
  const response = await apiFetch("/groups", { method: "POST", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ group: Group }>(response);
  return body.group;
}

export async function updateGroup(id: string, input: Partial<GroupInput>): Promise<Group> {
  const response = await apiFetch(`/groups/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ group: Group }>(response);
  return body.group;
}

export async function disableGroup(id: string): Promise<Group> {
  const response = await apiFetch(`/groups/${id}/disable`, { method: "POST" });
  const body = await parseOrThrow<{ group: Group }>(response);
  return body.group;
}

export async function enableGroup(id: string): Promise<Group> {
  const response = await apiFetch(`/groups/${id}/enable`, { method: "POST" });
  const body = await parseOrThrow<{ group: Group }>(response);
  return body.group;
}

export async function listGroupMembers(
  groupId: string,
  params: { search?: string; page?: number } = {},
): Promise<GroupMembersListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.page) query.set("page", String(params.page));

  const response = await apiFetch(`/groups/${groupId}/members?${query.toString()}`);
  return parseOrThrow<GroupMembersListResponse>(response);
}

export async function addGroupMembers(groupId: string, contactIds: string[]): Promise<AddMembersResult> {
  const response = await apiFetch(`/groups/${groupId}/members`, {
    method: "POST",
    body: JSON.stringify({ contactIds }),
  });
  return parseOrThrow<AddMembersResult>(response);
}

export async function removeGroupMember(groupId: string, contactId: string): Promise<void> {
  const response = await apiFetch(`/groups/${groupId}/members/${contactId}`, { method: "DELETE" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new Error(body.message ?? "Unable to remove this member.");
  }
}
