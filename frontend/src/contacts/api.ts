import { apiFetch } from "../lib/api";
import type { ApiErrorBody, Contact, ContactsListResponse, DuplicateMatch } from "./types";

export class DuplicateContactError extends Error {
  constructor(public readonly duplicates: DuplicateMatch[]) {
    super("This looks like an existing contact.");
    this.name = "DuplicateContactError";
  }
}

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    if (body.error === "likely_duplicate" && body.duplicates) {
      throw new DuplicateContactError(body.duplicates);
    }
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export interface ContactInput {
  firstName: string;
  lastName: string;
  referenceId?: string;
  email?: string;
  mobilePhone?: string;
  department?: string;
  confirmDuplicate?: boolean;
}

export async function listContacts(params: {
  search?: string;
  status?: string;
  page?: number;
}): Promise<ContactsListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.status) query.set("status", params.status);
  if (params.page) query.set("page", String(params.page));

  const response = await apiFetch(`/contacts?${query.toString()}`);
  return parseOrThrow<ContactsListResponse>(response);
}

export async function getContact(id: string): Promise<Contact> {
  const response = await apiFetch(`/contacts/${id}`);
  const body = await parseOrThrow<{ contact: Contact }>(response);
  return body.contact;
}

export async function createContact(input: ContactInput): Promise<Contact> {
  const response = await apiFetch("/contacts", { method: "POST", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ contact: Contact }>(response);
  return body.contact;
}

export async function updateContact(id: string, input: Partial<ContactInput>): Promise<Contact> {
  const response = await apiFetch(`/contacts/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ contact: Contact }>(response);
  return body.contact;
}

export async function disableContact(id: string): Promise<Contact> {
  const response = await apiFetch(`/contacts/${id}/disable`, { method: "POST" });
  const body = await parseOrThrow<{ contact: Contact }>(response);
  return body.contact;
}

export async function enableContact(id: string): Promise<Contact> {
  const response = await apiFetch(`/contacts/${id}/enable`, { method: "POST" });
  const body = await parseOrThrow<{ contact: Contact }>(response);
  return body.contact;
}
