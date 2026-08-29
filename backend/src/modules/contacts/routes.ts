import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requireCsrf } from "../auth/csrf.js";
import { requirePermission } from "../rbac/guard.js";
import * as contactsService from "./service.js";

interface ContactsRoutesOptions {
  config: AuthConfig;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
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

const createContactBodySchema = {
  type: "object",
  required: ["firstName", "lastName"],
  additionalProperties: false,
  properties: {
    firstName: { type: "string", minLength: 1, maxLength: 128 },
    lastName: { type: "string", minLength: 1, maxLength: 128 },
    referenceId: { type: "string", maxLength: 64 },
    email: { type: "string", maxLength: 255 },
    mobilePhone: { type: "string", maxLength: 64 },
    department: { type: "string", maxLength: 128 },
    confirmDuplicate: { type: "boolean" },
  },
} as const;

const updateContactBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    firstName: { type: "string", minLength: 1, maxLength: 128 },
    lastName: { type: "string", minLength: 1, maxLength: 128 },
    referenceId: { type: "string", maxLength: 64 },
    email: { type: "string", maxLength: 255 },
    mobilePhone: { type: "string", maxLength: 64 },
    department: { type: "string", maxLength: 128 },
    confirmDuplicate: { type: "boolean" },
  },
} as const;

export async function contactsRoutes(app: FastifyInstance, opts: ContactsRoutesOptions): Promise<void> {
  const { config } = opts;
  const authenticate = createAuthenticateHook(config);

  app.get(
    "/contacts",
    { preHandler: [authenticate, requirePermission("contacts.read")], schema: { querystring: listQuerySchema } },
    async (request) => {
      const query = request.query as { search?: string; status?: string; page?: number; pageSize?: number };
      return contactsService.listContacts(getDb(), query);
    },
  );

  app.get(
    "/contacts/:id",
    { preHandler: [authenticate, requirePermission("contacts.read")], schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      return { contact: await contactsService.getContact(getDb(), id) };
    },
  );

  app.post(
    "/contacts",
    {
      preHandler: [authenticate, requirePermission("contacts.create")],
      schema: { body: createContactBodySchema },
    },
    async (request, reply) => {
      requireCsrf(request, config);
      const body = request.body as contactsService.CreateContactInput;
      const contact = await contactsService.createContact(getDb(), body, request.authUser!.id);
      reply.status(201);
      return { contact };
    },
  );

  app.patch(
    "/contacts/:id",
    {
      preHandler: [authenticate, requirePermission("contacts.update")],
      schema: { params: idParamSchema, body: updateContactBodySchema },
    },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const body = request.body as contactsService.UpdateContactInput;
      const contact = await contactsService.updateContact(getDb(), id, body, request.authUser!.id);
      return { contact };
    },
  );

  app.post(
    "/contacts/:id/disable",
    {
      preHandler: [authenticate, requirePermission("contacts.disable")],
      schema: { params: idParamSchema },
    },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const contact = await contactsService.disableContact(getDb(), id, request.authUser!.id);
      return { contact };
    },
  );

  app.post(
    "/contacts/:id/enable",
    {
      preHandler: [authenticate, requirePermission("contacts.disable")],
      schema: { params: idParamSchema },
    },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const contact = await contactsService.enableContact(getDb(), id, request.authUser!.id);
      return { contact };
    },
  );
}
