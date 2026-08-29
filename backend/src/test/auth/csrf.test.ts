import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { generateCsrfToken, requireCsrf } from "../../modules/auth/csrf.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

const config = loadAuthConfig();

function fakeRequest(cookieToken: string | undefined, headerToken: string | string[] | undefined): FastifyRequest {
  return {
    cookies: cookieToken !== undefined ? { [config.csrfCookieName]: cookieToken } : {},
    headers: headerToken !== undefined ? { "x-csrf-token": headerToken } : {},
  } as unknown as FastifyRequest;
}

describe("requireCsrf (double-submit cookie)", () => {
  it("passes when the cookie and header match", () => {
    const token = generateCsrfToken();
    expect(() => requireCsrf(fakeRequest(token, token), config)).not.toThrow();
  });

  it("throws when the cookie is missing", () => {
    const token = generateCsrfToken();
    expect(() => requireCsrf(fakeRequest(undefined, token), config)).toThrow();
  });

  it("throws when the header is missing", () => {
    const token = generateCsrfToken();
    expect(() => requireCsrf(fakeRequest(token, undefined), config)).toThrow();
  });

  it("throws when the cookie and header don't match", () => {
    expect(() => requireCsrf(fakeRequest(generateCsrfToken(), generateCsrfToken()), config)).toThrow();
  });
});
