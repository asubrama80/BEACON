import { describe, expect, it } from "vitest";
import { loadNotificationConfig } from "../../modules/notifications/config.js";
import { getSmsProvider, getEmailProvider, getProviderStatus } from "../../modules/notifications/providers/registry.js";

describe("provider config and registry", () => {
  it("defaults to mock providers when nothing is configured", () => {
    const config = loadNotificationConfig({});
    expect(config.smsProvider).toBe("mock");
    expect(config.emailProvider).toBe("mock");
    expect(getSmsProvider(config).name).toBe("mock");
    expect(getEmailProvider(config).name).toBe("mock");
  });

  it("resolves the Twilio SMS provider when fully configured", () => {
    const config = loadNotificationConfig({
      SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      TWILIO_AUTH_TOKEN: "test-token",
      TWILIO_FROM_NUMBER: "+15550000000",
    });
    expect(getSmsProvider(config).name).toBe("twilio");
  });

  it("fails safely when SMS_PROVIDER=twilio is missing credentials — never silently falls back to mock", () => {
    const config = loadNotificationConfig({ SMS_PROVIDER: "twilio" });
    expect(config.twilio).toBeNull();
    expect(() => getSmsProvider(config)).toThrow(/TWILIO_ACCOUNT_SID/);
  });

  it("resolves the SES email provider when fully configured", () => {
    const config = loadNotificationConfig({ EMAIL_PROVIDER: "ses", AWS_REGION: "us-east-1", SES_FROM_EMAIL: "alerts@example.invalid" });
    expect(getEmailProvider(config).name).toBe("ses");
  });

  it("fails safely when EMAIL_PROVIDER=ses is missing credentials", () => {
    const config = loadNotificationConfig({ EMAIL_PROVIDER: "ses" });
    expect(config.ses).toBeNull();
    expect(() => getEmailProvider(config)).toThrow(/AWS_REGION/);
  });

  it("falls back to mock for an unrecognized provider name rather than throwing at config-load time", () => {
    const config = loadNotificationConfig({ SMS_PROVIDER: "unknown-provider" as never });
    expect(config.smsProvider).toBe("mock");
  });

  it("provider status never exposes credential values, only safe metadata", () => {
    const config = loadNotificationConfig({
      SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "ACsecretsecretsecretsecretsecretse",
      TWILIO_AUTH_TOKEN: "super-secret-auth-token",
      TWILIO_FROM_NUMBER: "+15550000000",
    });
    const status = getProviderStatus(config);
    expect(status).toEqual({ sms: { provider: "twilio", configured: true }, email: { provider: "mock", configured: true } });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("+15550000000");
  });
});
