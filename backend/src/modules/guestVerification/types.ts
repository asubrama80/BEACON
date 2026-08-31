import type { AuthenticatedGuest } from "./guestVerificationDto.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set only by `authenticateGuest()` — a Guest session context is never present alongside
     * `authUser` (they are two entirely separate authentication mechanisms). */
    authGuest?: AuthenticatedGuest;
  }
}
