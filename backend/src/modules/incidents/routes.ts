import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requireCsrf } from "../auth/csrf.js";
import { requirePermission } from "../rbac/guard.js";
import * as incidentsService from "./service.js";

interface IncidentsRoutesOptions {
  config: AuthConfig;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const participantIdParamSchema = {
  type: "object",
  required: ["id", "participantId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    participantId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const listQuerySchema = {
  type: "object",
  properties: {
    search: { type: "string", maxLength: 255 },
    status: { type: "string", enum: ["open", "active", "resolved", "closed"] },
    severity: { type: "string", enum: ["info", "warning", "high", "critical"] },
    commanderId: { type: "string", pattern: UUID_PATTERN },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

const pageQuerySchema = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

const timelineQuerySchema = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
    order: { type: "string", enum: ["asc", "desc"] },
  },
} as const;

const createIncidentBodySchema = {
  type: "object",
  required: ["title", "severity"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 255 },
    description: { type: "string", maxLength: 5000 },
    severity: { type: "string", enum: ["info", "warning", "high", "critical"] },
    commanderUserId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const updateIncidentBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 255 },
    description: { type: "string", maxLength: 5000 },
    severity: { type: "string", enum: ["info", "warning", "high", "critical"] },
  },
} as const;

const commanderBodySchema = {
  type: "object",
  required: ["userId"],
  additionalProperties: false,
  properties: { userId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const userParticipantBodySchema = {
  type: "object",
  required: ["userId"],
  additionalProperties: false,
  properties: { userId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const contactParticipantBodySchema = {
  type: "object",
  required: ["contactId"],
  additionalProperties: false,
  properties: { contactId: { type: "string", pattern: UUID_PATTERN } },
} as const;

export async function incidentsRoutes(app: FastifyInstance, opts: IncidentsRoutesOptions): Promise<void> {
  const { config } = opts;
  const authenticate = createAuthenticateHook(config);
  const canRead = requirePermission("incidents.read");
  const canCreate = requirePermission("incidents.create");
  const canUpdate = requirePermission("incidents.update");
  const canManageLifecycle = requirePermission("incidents.lifecycle.manage");
  const canAssignCommander = requirePermission("incidents.commander.assign");
  const canManageParticipants = requirePermission("incidents.participants.manage");
  const canReadTimeline = requirePermission("incidents.timeline.read");
  // Participant-list responses embed real Contact fields (email/phone), so viewing them requires
  // both incidents.read AND contacts.read — never just incidents.read alone. Mirrors Module 06's
  // Group-member dual-gate for the identical reason.
  const canReadContacts = requirePermission("contacts.read");

  app.get(
    "/incidents",
    { preHandler: [authenticate, canRead], schema: { querystring: listQuerySchema } },
    async (request) => {
      const query = request.query as {
        search?: string;
        status?: string;
        severity?: string;
        commanderId?: string;
        page?: number;
        pageSize?: number;
      };
      return incidentsService.listIncidents(getDb(), query);
    },
  );

  app.get(
    "/incidents/:id",
    { preHandler: [authenticate, canRead], schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      return { incident: await incidentsService.getIncident(getDb(), id) };
    },
  );

  app.post(
    "/incidents",
    { preHandler: [authenticate, canCreate], schema: { body: createIncidentBodySchema } },
    async (request, reply) => {
      requireCsrf(request, config);
      const body = request.body as incidentsService.CreateIncidentInput;
      const incident = await incidentsService.createIncident(getDb(), body, request.authUser!.id);
      reply.status(201);
      return { incident };
    },
  );

  app.patch(
    "/incidents/:id",
    { preHandler: [authenticate, canUpdate], schema: { params: idParamSchema, body: updateIncidentBodySchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const body = request.body as incidentsService.UpdateIncidentInput;
      const incident = await incidentsService.updateIncident(getDb(), id, body, request.authUser!.id);
      return { incident };
    },
  );

  app.post(
    "/incidents/:id/activate",
    { preHandler: [authenticate, canManageLifecycle], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const incident = await incidentsService.activateIncident(getDb(), id, request.authUser!.id);
      return { incident };
    },
  );

  app.post(
    "/incidents/:id/resolve",
    { preHandler: [authenticate, canManageLifecycle], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const incident = await incidentsService.resolveIncident(getDb(), id, request.authUser!.id);
      return { incident };
    },
  );

  app.post(
    "/incidents/:id/close",
    { preHandler: [authenticate, canManageLifecycle], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const incident = await incidentsService.closeIncident(getDb(), id, request.authUser!.id);
      return { incident };
    },
  );

  app.post(
    "/incidents/:id/reopen",
    { preHandler: [authenticate, canManageLifecycle], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const incident = await incidentsService.reopenIncident(getDb(), id, request.authUser!.id);
      return { incident };
    },
  );

  app.post(
    "/incidents/:id/commander",
    { preHandler: [authenticate, canAssignCommander], schema: { params: idParamSchema, body: commanderBodySchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const { userId } = request.body as { userId: string };
      const incident = await incidentsService.assignCommander(getDb(), id, userId, request.authUser!.id);
      return { incident };
    },
  );

  app.get(
    "/incidents/:id/participants",
    {
      preHandler: [authenticate, canRead, canReadContacts],
      schema: { params: idParamSchema, querystring: pageQuerySchema },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as { page?: number; pageSize?: number };
      return incidentsService.listParticipants(getDb(), id, query);
    },
  );

  app.post(
    "/incidents/:id/participants/users",
    {
      preHandler: [authenticate, canManageParticipants],
      schema: { params: idParamSchema, body: userParticipantBodySchema },
    },
    async (request, reply) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const { userId } = request.body as { userId: string };
      await incidentsService.addUserParticipant(getDb(), id, userId, request.authUser!.id);
      reply.status(201);
      return { added: true };
    },
  );

  app.post(
    "/incidents/:id/participants/contacts",
    {
      preHandler: [authenticate, canManageParticipants],
      schema: { params: idParamSchema, body: contactParticipantBodySchema },
    },
    async (request, reply) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const { contactId } = request.body as { contactId: string };
      await incidentsService.addContactParticipant(getDb(), id, contactId, request.authUser!.id);
      reply.status(201);
      return { added: true };
    },
  );

  app.delete(
    "/incidents/:id/participants/:participantId",
    { preHandler: [authenticate, canManageParticipants], schema: { params: participantIdParamSchema } },
    async (request, reply) => {
      requireCsrf(request, config);
      const { id, participantId } = request.params as { id: string; participantId: string };
      await incidentsService.removeParticipant(getDb(), id, participantId, request.authUser!.id);
      reply.status(204).send();
    },
  );

  app.get(
    "/incidents/:id/timeline",
    {
      preHandler: [authenticate, canReadTimeline],
      schema: { params: idParamSchema, querystring: timelineQuerySchema },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as { page?: number; pageSize?: number; order?: "asc" | "desc" };
      return incidentsService.listTimeline(getDb(), id, query);
    },
  );
}
