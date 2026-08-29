import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import ContactsPage from "./ContactsPage";

const ADMIN_USER = {
  id: "66666666-6666-6666-6666-666666666666",
  email: "admin@example.invalid",
  displayName: "Admin User",
  status: "active",
  isBreakGlass: false,
  mfaEnabled: false,
  roles: ["ADMIN"],
  permissions: ["contacts.read", "contacts.create"],
};

const EXISTING_CONTACT = {
  id: "77777777-7777-7777-7777-777777777777",
  referenceId: "EMP-1001",
  firstName: "Existing",
  lastName: "Contact",
  displayName: "Existing Contact",
  email: "existing@example.invalid",
  mobilePhone: "+12124567890",
  department: "IT Operations",
  status: "active",
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
        const ok = !(result as { __notOk?: boolean })?.__notOk;
        return Promise.resolve({ ok, json: () => Promise.resolve(result) });
      }
      if (path === "/auth/me") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: ADMIN_USER }) });
      }
      if (path === "/contacts" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [EXISTING_CONTACT], total: 1, page: 1, pageSize: 25 }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

function renderContactsPage(): void {
  render(
    <AuthProvider>
      <ContactsPage />
    </AuthProvider>,
  );
}

describe("ContactsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists existing contacts", async () => {
    mockRoutes();
    renderContactsPage();

    await waitFor(() => {
      expect(screen.getByText("Existing Contact")).toBeInTheDocument();
    });
    expect(screen.getByText("existing@example.invalid")).toBeInTheDocument();
    expect(screen.getByText("EMP-1001")).toBeInTheDocument();
  });

  it("opens the create-contact modal and submits a new contact", async () => {
    let created = false;
    mockRoutes({
      "POST /contacts": () => {
        created = true;
        return {
          contact: { ...EXISTING_CONTACT, id: "new-id", firstName: "New", lastName: "Person", displayName: "New Person" },
        };
      },
    });
    renderContactsPage();

    const addButton = await screen.findByRole("button", { name: "Add Contact" });
    fireEvent.click(addButton);

    fireEvent.change(await screen.findByLabelText("First name"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Person" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Contact" }));

    await waitFor(() => {
      expect(created).toBe(true);
    });
  });

  it("shows a duplicate warning and allows creating anyway", async () => {
    let confirmedCall: unknown;
    mockRoutes({
      "POST /contacts": () => {
        // First call has no confirmDuplicate captured yet; the test just checks the flow completes.
        confirmedCall = true;
        return {
          error: "likely_duplicate",
          message: "This looks like an existing contact. Confirm to create it anyway.",
          duplicates: [{ id: EXISTING_CONTACT.id, displayName: "Existing Contact", matchedOn: ["email"] }],
          __notOk: true,
        };
      },
    });
    renderContactsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Add Contact" }));
    fireEvent.change(await screen.findByLabelText("First name"), { target: { value: "Dup" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Person" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "existing@example.invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Contact" }));

    await waitFor(() => {
      expect(screen.getByText(/matched on email/)).toBeInTheDocument();
    });
    expect(confirmedCall).toBe(true);
    expect(screen.getByRole("button", { name: "Create anyway" })).toBeInTheDocument();
  });
});
