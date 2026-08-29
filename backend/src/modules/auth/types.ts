export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  isBreakGlass: boolean;
  mfaEnabled: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
    authSessionId?: string;
  }
}
