import { apiFetch } from "../lib/api";
import type { ApiErrorBody, DashboardData } from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export async function getDashboard(): Promise<DashboardData> {
  const response = await apiFetch("/dashboard");
  return parseOrThrow<DashboardData>(response);
}
