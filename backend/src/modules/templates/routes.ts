import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requireCsrf } from "../auth/csrf.js";
import { requirePermission } from "../rbac/guard.js";
import * as templatesService from "./service.js";

interface TemplatesRoutesOptions {
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
    channel: { type: "string", enum: ["sms", "email"] },
    status: { type: "string", enum: ["active", "inactive"] },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

const createBodySchema = {
  type: "object",
  required: ["name", "channel", "body"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 255 },
    channel: { type: "string", enum: ["sms", "email"] },
    subject: { type: "string", maxLength: 255 },
    body: { type: "string", minLength: 1, maxLength: 5000 },
  },
} as const;

const updateBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 255 },
    subject: { type: "string", maxLength: 255 },
    body: { type: "string", minLength: 1, maxLength: 5000 },
  },
} as const;

const previewBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    templateId: { type: "string", pattern: UUID_PATTERN },
    channel: { type: "string", enum: ["sms", "email"] },
    subject: { type: "string", maxLength: 255 },
    body: { type: "string", maxLength: 5000 },
  },
} as const;

export async function templatesRoutes(app: FastifyInstance, opts: TemplatesRoutesOptions): Promise<void> {
  const { config } = opts;
  const authenticate = createAuthenticateHook(config);
  const canRead = requirePermission("templates.read");
  const canCreate = requirePermission("templates.create");
  const canUpdate = requirePermission("templates.update");
  const canDisable = requirePermission("templates.disable");

  app.get(
    "/templates",
    { preHandler: [authenticate, canRead], schema: { querystring: listQuerySchema } },
    async (request) => {
      const query = request.query as {
        search?: string;
        channel?: string;
        status?: string;
        page?: number;
        pageSize?: number;
      };
      return templatesService.listTemplates(getDb(), query);
    },
  );

  app.get(
    "/templates/:id",
    { preHandler: [authenticate, canRead], schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      return { template: await templatesService.getTemplate(getDb(), id) };
    },
  );

  app.post(
    "/templates",
    { preHandler: [authenticate, canCreate], schema: { body: createBodySchema } },
    async (request, reply) => {
      requireCsrf(request, config);
      const body = request.body as templatesService.CreateTemplateInput;
      const template = await templatesService.createTemplate(getDb(), body, request.authUser!.id);
      reply.status(201);
      return { template };
    },
  );

  app.patch(
    "/templates/:id",
    { preHandler: [authenticate, canUpdate], schema: { params: idParamSchema, body: updateBodySchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const body = request.body as templatesService.UpdateTemplateInput;
      const template = await templatesService.updateTemplate(getDb(), id, body, request.authUser!.id);
      return { template };
    },
  );

  app.post(
    "/templates/:id/disable",
    { preHandler: [authenticate, canDisable], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const template = await templatesService.disableTemplate(getDb(), id, request.authUser!.id);
      return { template };
    },
  );

  app.post(
    "/templates/:id/enable",
    { preHandler: [authenticate, canDisable], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const template = await templatesService.enableTemplate(getDb(), id, request.authUser!.id);
      return { template };
    },
  );

  // Preview never creates a Contact, Alert, or persisted Template — synthetic sample values
  // only. Gated on templates.read (not create/update): rendering some text with sample values
  // exposes nothing sensitive, so the weakest relevant permission is sufficient. requireCsrf
  // still applies since it's a state-changing-shaped POST from the client's perspective, even
  // though nothing is actually persisted server-side.
  app.post(
    "/templates/preview",
    { preHandler: [authenticate, canRead], schema: { body: previewBodySchema } },
    async (request) => {
      requireCsrf(request, config);
      const body = request.body as templatesService.PreviewInput;
      return templatesService.previewTemplate(getDb(), body);
    },
  );
}
