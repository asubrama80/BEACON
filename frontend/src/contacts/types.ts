export interface Contact {
  id: string;
  referenceId: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string | null;
  mobilePhone: string | null;
  department: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContactsListResponse {
  items: Contact[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DuplicateMatch {
  id: string;
  displayName: string;
  matchedOn: ("email" | "mobilePhone")[];
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
  duplicates?: DuplicateMatch[];
}
