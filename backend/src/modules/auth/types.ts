export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  isBreakGlass: boolean;
  mfaEnabled: boolean;
  /** Role codes assigned to this user (Module 03). */
  roles: string[];
  /** Effective permission codes — the union of all assigned roles' permissions. Never secrets. */
  permissions: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
    authSessionId?: string;
  }
}
