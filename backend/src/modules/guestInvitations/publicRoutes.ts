import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import { getPublicInvitation } from "./guestInvitationService.js";

const TOKEN_PARAM_SCHEMA = {
  type: "object",
  required: ["token"],
  properties: { token: { type: "string", minLength: 1, maxLength: 512 } },
} as const;

/**
 * The public, unauthenticated guest-invitation lookup — no session, no CSRF (there is no session
 * yet at this point in the flow). Rate-limited per caller to blunt token-guessing, though the
 * token's own entropy (32 random bytes) is the real defense. See
 * claude/prompts/17-guest-invitations.md, "Public invitation lookup".
 */
export async function guestInvitationPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/guest/invitations/:token",
    {
      schema: { params: TOKEN_PARAM_SCHEMA },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { token } = request.params as { token: string };
      return getPublicInvitation(getDb(), token);
    },
  );
}
