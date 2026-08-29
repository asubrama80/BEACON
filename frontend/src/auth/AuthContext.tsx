import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "../lib/api";
import { AuthContext, type AuthUser } from "./context";

export type { AuthUser } from "./context";

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch("/auth/me");
      if (response.ok) {
        const body = (await response.json()) as { user: AuthUser };
        setUser(body.user);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const logout = useCallback(async () => {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}
