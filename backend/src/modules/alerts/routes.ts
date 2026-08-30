import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requireCsrf } from "../auth/csrf.js";
import { requirePermission } from "../rbac/guard.js";
import type { AlertConfig } from "./config.js";
import type { NotificationConfig } from "../notifications/config.js";
import { getProviderStatus } from "../notifications/providers/registry.js";
import * as alertsService from "./service.js";

interface AlertsRoutesOptions {
  config: AuthConfig;
  alertConfig: AlertConfig;
  notificationConfig: NotificationConfig;
  nodeEnv: string;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const recipientParamSchema = {
  type: "object",
  required: ["id", "recipientId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    recipientId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const mockDeliveryBodySchema = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["delivered", "undelivered", "bounced", "failed"] },
    errorCode: { type: "string", maxLength: 64 },
    safeErrorSummary: { type: "string", maxLength: 255 },
  },
} as const;

const listQuerySchema = {
  type: "object",
  properties: {
    search: { type: "string", maxLength: 255 },
    status: { type: "string", enum: ["draft", "ready", "cancelled"] },
    channel: { type: "string", enum: ["sms", "email"] },
    incidentId: { type: "string", pattern: UUID_PATTERN },
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

const idList = { type: "array", items: { type: "string", pattern: UUID_PATTERN }, maxItems: 500 } as const;

const createBodySchema = {
  type: "object",
  required: ["title", "channel", "contentSource"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 255 },
    incidentId: { type: "string", pattern: UUID_PATTERN },
    channel: { type: "string", enum: ["sms", "email"] },
    contentSource: { type: "string", enum: ["template", "adhoc"] },
    templateId: { type: "string", pattern: UUID_PATTERN },
    subject: { type: "string", maxLength: 255 },
    body: { type: "string", maxLength: 5000 },
    contactIds: idList,
    groupIds: idList,
  },
} as const;

const updateBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 255 },
    incidentId: { type: ["string", "null"], pattern: UUID_PATTERN },
    channel: { type: "string", enum: ["sms", "email"] },
    contentSource: { type: "string", enum: ["template", "adhoc"] },
    templateId: { type: ["string", "null"], pattern: UUID_PATTERN },
    subject: { type: "string", maxLength: 255 },
    body: { type: "string", maxLength: 5000 },
    contactIds: idList,
    groupIds: idList,
  },
} as const;

export async function alertsRoutes(app: FastifyInstance, opts: AlertsRoutesOptions): Promise<void> {
  const { config, alertConfig, notificationConfig, nodeEnv } = opts;
  const authenticate = createAuthenticateHook(config);
  const canRead = requirePermission("alerts.read");
  const canCreate = requirePermission("alerts.create");
  const canUpdate = requirePermission("alerts.update");
  const canReady = requirePermission("alerts.ready");
  const canCancel = requirePermission("alerts.cancel");
  const canReadRecipients = requirePermission("alerts.recipients.read");
  const canDispatch = requirePermission("alerts.dispatch");
  const canReadDelivery = requirePermission("alerts.delivery.read");

  // Safe, secret-free provider metadata (e.g. "sms: mock") — never credential values. Gated on
  // alerts.dispatch since only an operator who can actually dispatch needs this. See
  // claude/prompts/10-notification-providers.md, "Mock provider live validation".
  app.get("/alerts/provider-status", { preHandler: [authenticate, canDispatch] }, () => getProviderStatus(notificationConfig));

  app.get(
    "/alerts",
    { preHandler: [authenticate, canRead], schema: { querystring: listQuerySchema } },
    async (request) => {
      const query = request.query as {
        search?: string;
        status?: string;
        channel?: string;
        incidentId?: string;
        page?: number;
        pageSize?: number;
      };
      return alertsService.listAlerts(getDb(), query);
    },
  );

  app.get(
    "/alerts/:id",
    { preHandler: [authenticate, canRead], schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      return { alert: await alertsService.getAlert(getDb(), id) };
    },
  );

  app.post(
    "/alerts",
    { preHandler: [authenticate, canCreate], schema: { body: createBodySchema } },
    async (request, reply) => {
      requireCsrf(request, config);
      const body = request.body as alertsService.CreateAlertInput;
      const alert = await alertsService.createAlert(getDb(), body, request.authUser!.id);
      reply.status(201);
      return { alert };
    },
  );

  app.patch(
    "/alerts/:id",
    { preHandler: [authenticate, canUpdate], schema: { params: idParamSchema, body: updateBodySchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const body = request.body as alertsService.UpdateAlertInput;
      const alert = await alertsService.updateAlert(getDb(), id, body, request.authUser!.id);
      return { alert };
    },
  );

  app.post(
    "/alerts/:id/preview",
    { preHandler: [authenticate, canUpdate], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      return alertsService.previewAlert(getDb(), id);
    },
  );

  app.post(
    "/alerts/:id/ready",
    { preHandler: [authenticate, canReady], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const alert = await alertsService.readyAlert(getDb(), id, request.authUser!.id, alertConfig);
      return { alert };
    },
  );

  app.post(
    "/alerts/:id/cancel",
    { preHandler: [authenticate, canCancel], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const alert = await alertsService.cancelAlert(getDb(), id, request.authUser!.id);
      return { alert };
    },
  );

  // Separate from alerts.ready — approving a plan (READY) and beginning external provider
  // submission (Dispatch) are different operational decisions. See
  // claude/prompts/10-notification-providers.md, "READY vs Dispatch".
  app.post(
    "/alerts/:id/dispatch",
    { preHandler: [authenticate, canDispatch], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      return alertsService.dispatchAlert(getDb(), id, request.authUser!.id, notificationConfig);
    },
  );

  // Recipient rows carry destination PII (phone/email) — gated separately from alerts.read.
  // See claude/prompts/09-alert-engine.md, "Recipient PII permission".
  app.get(
    "/alerts/:id/recipients",
    { preHandler: [authenticate, canReadRecipients], schema: { params: idParamSchema, querystring: pageQuerySchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as { page?: number; pageSize?: number };
      return alertsService.listAlertRecipients(getDb(), id, query);
    },
  );

  // Recipient-level delivery EVENT HISTORY (per-event timestamps/error codes) — an additional
  // gate on top of alerts.recipients.read, distinct from the safe aggregate deliverySummary
  // already folded into GET /alerts/:id. See claude/prompts/11-delivery-tracking.md, "Permissions".
  app.get(
    "/alerts/:id/recipients/:recipientId/delivery-events",
    {
      preHandler: [authenticate, canReadRecipients, canReadDelivery],
      schema: { params: recipientParamSchema },
    },
    async (request) => {
      const { id, recipientId } = request.params as { id: string; recipientId: string };
      const items = await alertsService.listRecipientDeliveryEvents(getDb(), id, recipientId);
      return { items };
    },
  );

  // Development/test-only delivery-outcome simulation — performs zero network communication,
  // never present outside development/test, gated on alerts.dispatch. See
  // claude/prompts/11-delivery-tracking.md, "Mock delivery simulation".
  if (nodeEnv !== "production") {
    app.post(
      "/alerts/:id/recipients/:recipientId/mock-delivery",
      {
        preHandler: [authenticate, canDispatch],
        schema: { params: recipientParamSchema, body: mockDeliveryBodySchema },
      },
      async (request) => {
        requireCsrf(request, config);
        const { id, recipientId } = request.params as { id: string; recipientId: string };
        const body = request.body as alertsService.SimulateMockDeliveryInput;
        const recipient = await alertsService.simulateMockDelivery(getDb(), id, recipientId, body);
        return { recipient };
      },
    );
  }
}
