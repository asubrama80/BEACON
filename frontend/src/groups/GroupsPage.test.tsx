import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import GroupsPage from "./GroupsPage";

const ADMIN_USER = {
  id: "88888888-8888-8888-8888-888888888888",
  email: "admin@example.invalid",
  displayName: "Admin User",
  status: "active",
  isBreakGlass: false,
  mfaEnabled: false,
  roles: ["ADMIN"],
  permissions: ["groups.read", "groups.create", "groups.update", "groups.disable", "groups.members.manage", "contacts.read"],
};

const EXISTING_GROUP = {
  id: "99999999-9999-9999-9999-999999999999",
  name: "Executive Crisis Team",
  description: "Senior leadership",
  status: "active",
  memberCount: 2,
  activeMemberCount: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const EXISTING_MEMBER = {
  contactId: "aaaaaaaa-1111-1111-1111-111111111111",
  displayName: "Existing Member",
  firstName: "Existing",
  lastName: "Member",
  email: "existing.member@example.invalid",
  mobilePhone: null,
  department: null,
  referenceId: null,
  contactStatus: "inactive",
  addedAt: "2026-01-01T00:00:00.000Z",
};

const SEARCHABLE_CONTACT = {
  id: "bbbbbbbb-2222-2222-2222-222222222222",
  referenceId: "EMP-2002",
  firstName: "Findable",
  lastName: "Contact",
  displayName: "Findable Contact",
  email: "findable@example.invalid",
  mobilePhone: null,
  department: null,
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
        return Promise.resolve({ ok: true, json: () => Promise.resolve(result) });
      }
      if (path === "/auth/me") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: ADMIN_USER }) });
      }
      if (path === "/groups" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [EXISTING_GROUP], total: 1, page: 1, pageSize: 25 }),
        });
      }
      if (path === `/groups/${EXISTING_GROUP.id}/members` && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [EXISTING_MEMBER], total: 1, page: 1, pageSize: 25 }),
        });
      }
      if (path === "/contacts" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [SEARCHABLE_CONTACT], total: 1, page: 1, pageSize: 25 }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

function renderGroupsPage(): void {
  render(
    <AuthProvider>
      <GroupsPage />
    </AuthProvider>,
  );
}

describe("GroupsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists existing groups with member counts", async () => {
    mockRoutes();
    renderGroupsPage();

    await waitFor(() => {
      expect(screen.getByText("Executive Crisis Team")).toBeInTheDocument();
    });
    expect(screen.getByText("2 members (1 active)")).toBeInTheDocument();
  });

  it("opens the create-group modal and submits a new group", async () => {
    let created = false;
    mockRoutes({
      "POST /groups": () => {
        created = true;
        return { group: { ...EXISTING_GROUP, id: "new-id", name: "IT Operations" } };
      },
    });
    renderGroupsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create Group" }));
    fireEvent.change(await screen.findByLabelText("Group name"), { target: { value: "IT Operations" } });
    const submitButtons = screen.getAllByRole("button", { name: "Create Group" });
    fireEvent.click(submitButtons[submitButtons.length - 1]!);

    await waitFor(() => {
      expect(created).toBe(true);
    });
  });

  it("shows an inactive member badge and allows searching/adding a new contact", async () => {
    let addedContactIds: string[] = [];
    mockRoutes({
      [`POST /groups/${EXISTING_GROUP.id}/members`]: () => {
        addedContactIds = [SEARCHABLE_CONTACT.id];
        return { added: [SEARCHABLE_CONTACT.id], alreadyMember: [], notFound: [] };
      },
    });
    renderGroupsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Members" }));

    await screen.findByText("Existing Member");
    expect(screen.getByText("inactive")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search contacts by name, ID, or email"), {
      target: { value: "Findable" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await screen.findByText("Findable Contact");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Findable Contact" }));
    fireEvent.click(screen.getByRole("button", { name: /Add Selected/ }));

    await waitFor(() => {
      expect(addedContactIds).toEqual([SEARCHABLE_CONTACT.id]);
    });
  });

  it("removes a member", async () => {
    let removed = false;
    mockRoutes({
      [`DELETE /groups/${EXISTING_GROUP.id}/members/${EXISTING_MEMBER.contactId}`]: () => {
        removed = true;
        return {};
      },
    });
    renderGroupsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Members" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(removed).toBe(true);
    });
  });
});
