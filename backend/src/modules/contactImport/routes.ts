import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { AuthError } from "../auth/errors.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requireCsrf } from "../auth/csrf.js";
import { requirePermission } from "../rbac/guard.js";
import type { ContactImportConfig } from "./config.js";
import { ALLOWED_DESTINATION_FIELDS, type ColumnMapping } from "./mapping.js";
import * as importService from "./service.js";

interface ContactImportRoutesOptions {
  config: AuthConfig;
  importConfig: ContactImportConfig;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const batchIdParamSchema = {
  type: "object",
  required: ["batchId"],
  properties: { batchId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const previewBodySchema = {
  type: "object",
  required: ["mapping"],
  additionalProperties: false,
  properties: {
    mapping: {
      type: "object",
      additionalProperties: { type: "string", enum: [...ALLOWED_DESTINATION_FIELDS] },
    },
  },
} as const;

const confirmBodySchema = {
  type: "object",
  required: ["decisions"],
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      maxItems: 5000,
      items: {
        type: "object",
        required: ["rowId", "selected"],
        additionalProperties: false,
        properties: {
          rowId: { type: "string", pattern: UUID_PATTERN },
          selected: { type: "boolean" },
          confirmDuplicate: { type: "boolean" },
        },
      },
    },
  },
} as const;

const getQuerySchema = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 200 },
    status: { type: "string", enum: ["valid", "invalid", "possible_duplicate", "duplicate_in_file"] },
  },
} as const;

export async function contactImportRoutes(app: FastifyInstance, opts: ContactImportRoutesOptions): Promise<void> {
  const { config, importConfig } = opts;
  const authenticate = createAuthenticateHook(config);
  const permission = requirePermission("contacts.import");

  app.post(
    "/contacts/import/upload",
    { preHandler: [authenticate, permission] },
    async (request, reply) => {
      requireCsrf(request, config);

      const file = await request.file({ limits: { fileSize: importConfig.maxFileSizeBytes, files: 1 } });
      if (!file) {
        throw new AuthError(400, "import_file_invalid", "No file was uploaded.");
      }

      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch {
        // @fastify/multipart throws when the stream is cut off by the configured fileSize limit.
        throw new AuthError(
          400,
          "import_file_invalid",
          `File is too large (max ${Math.floor(importConfig.maxFileSizeBytes / (1024 * 1024))} MB).`,
        );
      }
      if (file.file.truncated) {
        throw new AuthError(
          400,
          "import_file_invalid",
          `File is too large (max ${Math.floor(importConfig.maxFileSizeBytes / (1024 * 1024))} MB).`,
        );
      }

      const result = await importService.uploadFile(
        getDb(),
        importConfig,
        request.authUser!.id,
        file.filename,
        buffer,
      );
      reply.status(201);
      return result;
    },
  );

  app.post(
    "/contacts/import/:batchId/preview",
    {
      preHandler: [authenticate, permission],
      schema: { params: batchIdParamSchema, body: previewBodySchema },
    },
    async (request) => {
      requireCsrf(request, config);
      const { batchId } = request.params as { batchId: string };
      const { mapping } = request.body as { mapping: ColumnMapping };
      return importService.previewBatch(getDb(), request.authUser!.id, batchId, mapping);
    },
  );

  app.get(
    "/contacts/import/:batchId",
    {
      preHandler: [authenticate, permission],
      schema: { params: batchIdParamSchema, querystring: getQuerySchema },
    },
    async (request) => {
      const { batchId } = request.params as { batchId: string };
      const query = request.query as { page?: number; pageSize?: number; status?: importService.GetBatchOptions["status"] };
      return importService.getBatch(getDb(), request.authUser!.id, batchId, query);
    },
  );

  app.post(
    "/contacts/import/:batchId/confirm",
    {
      preHandler: [authenticate, permission],
      schema: { params: batchIdParamSchema, body: confirmBodySchema },
    },
    async (request) => {
      requireCsrf(request, config);
      const { batchId } = request.params as { batchId: string };
      const { decisions } = request.body as { decisions: importService.RowDecision[] };
      return importService.confirmBatch(getDb(), request.authUser!.id, batchId, decisions);
    },
  );
}
