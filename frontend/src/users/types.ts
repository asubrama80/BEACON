export interface UserRoleRef {
  id: string;
  code: string;
  name: string;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  status: string;
  isBreakGlass: boolean;
  roles: UserRoleRef[];
  createdAt: string;
  updatedAt: string;
}

export interface UserDetail extends UserSummary {
  effectivePermissions: string[];
  mfaEnabled: boolean;
}

export interface UsersListResponse {
  items: UserSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RoleRef {
  id: string;
  code: string;
  name: string;
  description: string | null;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
