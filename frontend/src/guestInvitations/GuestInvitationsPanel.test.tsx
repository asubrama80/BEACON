import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GuestInvitationsPanel from "./GuestInvitationsPanel";

const INCIDENT_ID = "99999999-9999-9999-9999-999999999999";

function mockRoutes(overrides: Record<string, () => unknown> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      const key = `${method} ${path}`;
      if (overrides[key]) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(overrides[key]!()) });
      }
      if (path === `/incidents/${INCIDENT_ID}/guest-invitations` && method === "GET") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

function renderPanel(props: Partial<Parameters<typeof GuestInvitationsPanel>[0]> = {}): void {
  render(
    <GuestInvitationsPanel incidentId={INCIDENT_ID} canRead={true} canInvite={true} canRevoke={true} isClosed={false} {...props} />,
  );
}

const SAMPLE_INVITATION = {
  id: "inv-1",
  incidentId: INCIDENT_ID,
  guestName: "Jane Guest",
  email: "jane@example.invalid",
  mobilePhone: null,
  status: "sent",
  capabilities: { chat: true, warRoom: false },
  expiresAt: "2026-01-02T00:00:00.000Z",
  verifiedAt: null,
  joinedAt: null,
  revokedAt: null,
  revokedByDisplayName: null,
  invitedByDisplayName: "Admin User",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("GuestInvitationsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows read-only messaging without incidents.guests.read", () => {
    mockRoutes();
    renderPanel({ canRead: false });
    expect(screen.getByText(/don't have permission to view this incident's guest invitations/)).toBeInTheDocument();
  });

  it("shows an empty state with no invitations yet", async () => {
    mockRoutes();
    renderPanel();
    await screen.findByText("No guest invitations for this Incident yet.");
  });

  it("hides the Invite Guest button without invite permission", async () => {
    mockRoutes();
    renderPanel({ canInvite: false });
    await screen.findByText("No guest invitations for this Incident yet.");
    expect(screen.queryByRole("button", { name: "Invite Guest" })).not.toBeInTheDocument();
  });

  it("lists an existing invitation with its status badge and capabilities", async () => {
    mockRoutes({ [`GET /incidents/${INCIDENT_ID}/guest-invitations`]: () => ({ items: [SAMPLE_INVITATION] }) });
    renderPanel();
    await screen.findByText("Jane Guest");
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("creates an invitation, shows the dev-only link once, and refreshes the list", async () => {
    let created = false;
    mockRoutes({
      [`GET /incidents/${INCIDENT_ID}/guest-invitations`]: () => ({ items: created ? [SAMPLE_INVITATION] : [] }),
      [`POST /incidents/${INCIDENT_ID}/guest-invitations`]: () => {
        created = true;
        return { invitation: SAMPLE_INVITATION, invitationUrl: "http://localhost:5173/guest/invite/RAW-TOKEN-VALUE" };
      },
    });
    renderPanel();
    await screen.findByText("No guest invitations for this Incident yet.");

    fireEvent.click(screen.getByRole("button", { name: "Invite Guest" }));
    fireEvent.change(screen.getByLabelText("Guest name"), { target: { value: "Jane Guest" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jane@example.invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Send Invitation" }));

    await screen.findByText(/DEV ONLY/);
    expect(screen.getByText(/RAW-TOKEN-VALUE/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Jane Guest")).toBeInTheDocument());
  });

  it("never renders a tokenHash field anywhere in the DOM", async () => {
    mockRoutes({ [`GET /incidents/${INCIDENT_ID}/guest-invitations`]: () => ({ items: [SAMPLE_INVITATION] }) });
    renderPanel();
    await screen.findByText("Jane Guest");
    expect(document.body.textContent).not.toMatch(/tokenHash|token_hash/i);
  });

  it("revokes an invitation", async () => {
    let revoked = false;
    mockRoutes({
      [`GET /incidents/${INCIDENT_ID}/guest-invitations`]: () => ({
        items: [revoked ? { ...SAMPLE_INVITATION, status: "revoked" } : SAMPLE_INVITATION],
      }),
      [`POST /incidents/${INCIDENT_ID}/guest-invitations/inv-1/revoke`]: () => {
        revoked = true;
        return { ...SAMPLE_INVITATION, status: "revoked" };
      },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await screen.findByText("Revoked");
  });

  it("hides the Revoke action without revoke permission", async () => {
    mockRoutes({ [`GET /incidents/${INCIDENT_ID}/guest-invitations`]: () => ({ items: [SAMPLE_INVITATION] }) });
    renderPanel({ canRevoke: false });
    await screen.findByText("Jane Guest");
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("hides the Invite Guest button when the Incident is closed", async () => {
    mockRoutes();
    renderPanel({ isClosed: true });
    await screen.findByText("No guest invitations for this Incident yet.");
    expect(screen.queryByRole("button", { name: "Invite Guest" })).not.toBeInTheDocument();
  });
});
