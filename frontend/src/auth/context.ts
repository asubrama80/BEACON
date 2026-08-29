import { createContext } from "react";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  isBreakGlass: boolean;
  mfaEnabled: boolean;
  roles: string[];
  permissions: string[];
}

export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
