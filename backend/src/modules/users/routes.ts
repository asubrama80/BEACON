import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requireCsrf } from "../auth/csrf.js";
import { requirePermission } from "../rbac/guard.js";
import * as usersService from "./service.js";

interface UsersRoutesOptions {
  config: AuthConfig;
}

const listQuerySchema = {
  type: "object",
  properties: {
    search: { type: "string", maxLength: 255 },
    status: { type: "string", enum: ["active", "inactive", "suspended"] },
    roleCode: { type: "string", maxLength: 64 },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

// additionalProperties:false on every mutating body schema below is a defense-in-depth
// mass-assignment guard: a request that includes e.g. `passwordHash`, `isBreakGlass`, or
// `status` is rejected outright with 400 rather than the field being silently ignored. The
// service layer (service.ts) never spreads the raw body either way — it always reads named
// fields explicitly — so this is a second, independent layer, not the only one.
const createUserBodySchema = {
  type: "object",
  required: ["email", "displayName", "initialPassword"],
  additionalProperties: false,
  properties: {
    email: { type: "string", minLength: 3, maxLength: 255 },
    displayName: { type: "string", minLength: 1, maxLength: 255 },
    initialPassword: { type: "string", minLength: 1, maxLength: 512 },
    roleCodes: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 10 },
  },
} as const;

const updateUserBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    email: { type: "string", minLength: 3, maxLength: 255 },
    displayName: { type: "string", minLength: 1, maxLength: 255 },
  },
} as const;

const assignRoleBodySchema = {
  type: "object",
  required: ["roleCode"],
  additionalProperties: false,
  properties: { roleCode: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

const resetPasswordBodySchema = {
  type: "object",
  required: ["newPassword"],
  additionalProperties: false,
  properties: { newPassword: { type: "string", minLength: 1, maxLength: 512 } },
} as const;

export async function usersRoutes(app: FastifyInstance, opts: UsersRoutesOptions): Promise<void> {
  const { config } = opts;
  const authenticate = createAuthenticateHook(config);

  app.get(
    "/users",
    { preHandler: [authenticate, requirePermission("users.read")], schema: { querystring: listQuerySchema } },
    async (request) => {
      const query = request.query as {
        search?: string;
        status?: string;
        roleCode?: string;
        page?: number;
        pageSize?: number;
      };
      return usersService.listUsers(getDb(), query);
    },
  );

  app.get(
    "/users/:id",
    { preHandler: [authenticate, requirePermission("users.read")] },
    async (request) => {
      const { id } = request.params as { id: string };
      return { user: await usersService.getUser(getDb(), id) };
    },
  );

  app.post(
    "/users",
    {
      preHandler: [authenticate, requirePermission("users.create")],
      schema: { body: createUserBodySchema },
    },
    async (request, reply) => {
      requireCsrf(request, config);
      const body = request.body as {
        email: string;
        displayName: string;
        initialPassword: string;
        roleCodes?: string[];
      };
      const user = await usersService.createUser(getDb(), body, config, request.authUser!.id);
      reply.status(201);
      return { user };
    },
  );

  app.patch(
    "/users/:id",
    {
      preHandler: [authenticate, requirePermission("users.update")],
      schema: { body: updateUserBodySchema },
    },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const body = request.body as { email?: string; displayName?: string };
      const user = await usersService.updateUser(getDb(), id, body, request.authUser!.id);
      return { user };
    },
  );

  app.post(
    "/users/:id/disable",
    { preHandler: [authenticate, requirePermission("users.disable")] },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const user = await usersService.disableUser(getDb(), id, request.authUser!.id);
      return { user };
    },
  );

  app.post(
    "/users/:id/enable",
    { preHandler: [authenticate, requirePermission("users.disable")] },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const user = await usersService.enableUser(getDb(), id, request.authUser!.id);
      return { user };
    },
  );

  app.post(
    "/users/:id/roles",
    {
      preHandler: [authenticate, requirePermission("users.roles.assign")],
      schema: { body: assignRoleBodySchema },
    },
    async (request, reply) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const { roleCode } = request.body as { roleCode: string };
      const user = await usersService.assignRole(getDb(), id, roleCode, request.authUser!.id);
      reply.status(201);
      return { user };
    },
  );

  app.delete(
    "/users/:id/roles/:roleCode",
    { preHandler: [authenticate, requirePermission("users.roles.assign")] },
    async (request) => {
      requireCsrf(request, config);
      const { id, roleCode } = request.params as { id: string; roleCode: string };
      const user = await usersService.removeRole(getDb(), id, roleCode, request.authUser!.id);
      return { user };
    },
  );

  app.post(
    "/users/:id/reset-password",
    {
      preHandler: [authenticate, requirePermission("users.update")],
      schema: { body: resetPasswordBodySchema },
    },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const { newPassword } = request.body as { newPassword: string };
      await usersService.resetPassword(getDb(), id, newPassword, config, request.authUser!.id);
      return { success: true };
    },
  );
}
