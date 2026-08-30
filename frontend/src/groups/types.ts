export interface Group {
  id: string;
  name: string;
  description: string | null;
  status: string;
  memberCount: number;
  activeMemberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupsListResponse {
  items: Group[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GroupMember {
  contactId: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  mobilePhone: string | null;
  department: string | null;
  referenceId: string | null;
  contactStatus: string;
  addedAt: string;
}

export interface GroupMembersListResponse {
  items: GroupMember[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AddMembersResult {
  added: string[];
  alreadyMember: string[];
  notFound: string[];
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
