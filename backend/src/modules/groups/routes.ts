import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requireCsrf } from "../auth/csrf.js";
import { requirePermission } from "../rbac/guard.js";
import * as groupsService from "./service.js";

interface GroupsRoutesOptions {
  config: AuthConfig;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const memberParamSchema = {
  type: "object",
  required: ["id", "contactId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    contactId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const listQuerySchema = {
  type: "object",
  properties: {
    search: { type: "string", maxLength: 255 },
    status: { type: "string", enum: ["active", "inactive"] },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

const membersQuerySchema = {
  type: "object",
  properties: {
    search: { type: "string", maxLength: 255 },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

const createGroupBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 255 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const updateGroupBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 255 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const addMembersBodySchema = {
  type: "object",
  required: ["contactIds"],
  additionalProperties: false,
  properties: {
    contactIds: {
      type: "array",
      minItems: 1,
      maxItems: 500,
      items: { type: "string", pattern: UUID_PATTERN },
    },
  },
} as const;

export async function groupsRoutes(app: FastifyInstance, opts: GroupsRoutesOptions): Promise<void> {
  const { config } = opts;
  const authenticate = createAuthenticateHook(config);
  const canRead = requirePermission("groups.read");
  const canCreate = requirePermission("groups.create");
  const canUpdate = requirePermission("groups.update");
  const canDisable = requirePermission("groups.disable");
  const canManageMembers = requirePermission("groups.members.manage");
  // Member-list responses embed real Contact fields (email/phone), so viewing them requires
  // both groups.read AND contacts.read — never just groups.read alone. See
  // claude/prompts/06-groups.md, "Contact read dependency".
  const canReadContacts = requirePermission("contacts.read");

  app.get(
    "/groups",
    { preHandler: [authenticate, canRead], schema: { querystring: listQuerySchema } },
    async (request) => {
      const query = request.query as { search?: string; status?: string; page?: number; pageSize?: number };
      return groupsService.listGroups(getDb(), query);
    },
  );

  app.get(
    "/groups/:id",
    { preHandler: [authenticate, canRead], schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      return { group: await groupsService.getGroup(getDb(), id) };
    },
  );

  app.post(
    "/groups",
    { preHandler: [authenticate, canCreate], schema: { body: createGroupBodySchema } },
    async (request, reply) => {
      requireCsrf(request, config);
      const body = request.body as groupsService.CreateGroupInput;
      const group = await groupsService.createGroup(getDb(), body, request.authUser!.id);
      reply.status(201);
      return { group };
    },
  );

  app.patch(
    "/groups/:id",
    { preHandler: [authenticate, canUpdate], schema: { params: idParamSchema, body: updateGroupBodySchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const body = request.body as groupsService.UpdateGroupInput;
      const group = await groupsService.updateGroup(getDb(), id, body, request.authUser!.id);
      return { group };
    },
  );

  app.post(
    "/groups/:id/disable",
    { preHandler: [authenticate, canDisable], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const group = await groupsService.disableGroup(getDb(), id, request.authUser!.id);
      return { group };
    },
  );

  app.post(
    "/groups/:id/enable",
    { preHandler: [authenticate, canDisable], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const group = await groupsService.enableGroup(getDb(), id, request.authUser!.id);
      return { group };
    },
  );

  app.get(
    "/groups/:id/members",
    {
      preHandler: [authenticate, canRead, canReadContacts],
      schema: { params: idParamSchema, querystring: membersQuerySchema },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as { search?: string; page?: number; pageSize?: number };
      return groupsService.listMembers(getDb(), id, query);
    },
  );

  app.post(
    "/groups/:id/members",
    {
      preHandler: [authenticate, canManageMembers],
      schema: { params: idParamSchema, body: addMembersBodySchema },
    },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const { contactIds } = request.body as { contactIds: string[] };
      return groupsService.addMembers(getDb(), id, contactIds, request.authUser!.id);
    },
  );

  app.delete(
    "/groups/:id/members/:contactId",
    { preHandler: [authenticate, canManageMembers], schema: { params: memberParamSchema } },
    async (request, reply) => {
      requireCsrf(request, config);
      const { id, contactId } = request.params as { id: string; contactId: string };
      await groupsService.removeMember(getDb(), id, contactId, request.authUser!.id);
      // A 204 response must carry no body — explicitly `.send()` with nothing rather than
      // just setting the status code, otherwise Fastify's default serialization of the
      // handler's (undefined) return value produces a Content-Length/body mismatch that
      // browsers reject outright (net::ERR_FAILED), never reaching the caller as a normal response.
      reply.status(204).send();
    },
  );
}
