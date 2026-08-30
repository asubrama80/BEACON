import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import TemplatesPage from "./TemplatesPage";

const ADMIN_USER = {
  id: "aaaaaaaa-0000-0000-0000-000000000000",
  email: "admin@example.invalid",
  displayName: "Admin User",
  status: "active",
  isBreakGlass: false,
  mfaEnabled: false,
  roles: ["ADMIN"],
  permissions: ["templates.read", "templates.create", "templates.update", "templates.disable"],
};

const EXISTING_SMS_TEMPLATE = {
  id: "bbbbbbbb-1111-1111-1111-111111111111",
  name: "Emergency Closure",
  channel: "sms",
  subject: null,
  status: "active",
  placeholders: ["firstName"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function mockRoutes(overrides: Record<string, () => unknown> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      const key = `${method} ${path}`;

      if (overrides[key]) {
        const result = overrides[key]!();
        return Promise.resolve({ ok: true, json: () => Promise.resolve(result) });
      }
      if (path === "/auth/me") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: ADMIN_USER }) });
      }
      if (path === "/templates" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [EXISTING_SMS_TEMPLATE], total: 1, page: 1, pageSize: 25 }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

function renderTemplatesPage(): void {
  render(
    <AuthProvider>
      <TemplatesPage />
    </AuthProvider>,
  );
}

describe("TemplatesPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists existing templates with channel and status badges", async () => {
    mockRoutes();
    renderTemplatesPage();

    await waitFor(() => {
      expect(screen.getByText("Emergency Closure")).toBeInTheDocument();
    });
    expect(screen.getByText("SMS", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("creates an SMS template with an inserted placeholder", async () => {
    let created = false;
    let createdBody = "";
    mockRoutes({
      "POST /templates": () => {
        created = true;
        return { template: { ...EXISTING_SMS_TEMPLATE, id: "new-id", name: "New Template" } };
      },
    });
    renderTemplatesPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create Template" }));
    fireEvent.change(await screen.findByLabelText("Template name"), { target: { value: "New Template" } });

    const bodyField = screen.getByLabelText("Message body") as HTMLTextAreaElement;
    fireEvent.change(bodyField, { target: { value: "Hello " } });
    fireEvent.click(screen.getByRole("button", { name: "First Name" }));
    createdBody = bodyField.value;

    const submitButtons = screen.getAllByRole("button", { name: "Save Template" });
    fireEvent.click(submitButtons[submitButtons.length - 1]!);

    await waitFor(() => {
      expect(created).toBe(true);
    });
    expect(createdBody).toContain("{{firstName}}");
  });

  it("requires a subject for an Email template", async () => {
    mockRoutes();
    renderTemplatesPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create Template" }));
    fireEvent.change(await screen.findByLabelText("Channel"), { target: { value: "email" } });

    expect(await screen.findByLabelText("Subject")).toBeInTheDocument();
  });

  it("shows a rendered preview with synthetic values", async () => {
    mockRoutes({
      "POST /templates/preview": () => ({
        channel: "sms",
        renderedBody: "Hello Alex, this is a test.",
        unresolvedPlaceholders: [],
        sms: { encoding: "GSM-7", characterCount: 27, gsmUnitCount: 27, segmentCount: 1 },
      }),
    });
    renderTemplatesPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create Template" }));
    fireEvent.change(await screen.findByLabelText("Message body"), { target: { value: "Hello {{firstName}}, this is a test." } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await screen.findByText("Hello Alex, this is a test.");
    expect(screen.getByText(/GSM-7/)).toBeInTheDocument();
  });

  it("opens the detail modal, edits the body, and disables the template", async () => {
    let disabled = false;
    mockRoutes({
      [`GET /templates/${EXISTING_SMS_TEMPLATE.id}`]: () => ({ template: { ...EXISTING_SMS_TEMPLATE, body: "Original body" } }),
      [`POST /templates/${EXISTING_SMS_TEMPLATE.id}/disable`]: () => {
        disabled = true;
        return { template: { ...EXISTING_SMS_TEMPLATE, status: "inactive", body: "Original body" } };
      },
    });
    renderTemplatesPage();

    fireEvent.click(await screen.findByRole("button", { name: "View / Edit" }));
    await screen.findByDisplayValue("Original body");

    fireEvent.click(screen.getByRole("button", { name: "Disable template" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm disable" }));

    await waitFor(() => {
      expect(disabled).toBe(true);
    });
  });

  it("hides the Create Template button without templates.create", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/auth/me") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ user: { ...ADMIN_USER, roles: ["AUDITOR"], permissions: ["templates.read"] } }),
          });
        }
        if (path === "/templates" && method === "GET") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 25 }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
    renderTemplatesPage();

    await waitFor(() => {
      expect(screen.getByText("Templates")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Create Template" })).not.toBeInTheDocument();
  });
});
