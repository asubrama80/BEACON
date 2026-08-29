import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthContext";
import LoginPage from "./LoginPage";

interface MockResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

function mockFetchByPath(responses: Record<string, MockResponse>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const response = responses[path];
      if (!response) {
        throw new Error(`Unexpected fetch to ${path} in test`);
      }
      return Promise.resolve(response);
    }),
  );
}

function renderLoginPage(): void {
  render(
    <AuthProvider>
      <LoginPage />
    </AuthProvider>,
  );
}

describe("LoginPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders email and password fields", () => {
    mockFetchByPath({ "/auth/me": { ok: false, json: () => Promise.resolve({}) } });
    renderLoginPage();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows a generic error message on invalid credentials", async () => {
    mockFetchByPath({
      "/auth/me": { ok: false, json: () => Promise.resolve({}) },
      "/auth/login": {
        ok: false,
        json: () => Promise.resolve({ error: "invalid_credentials", message: "Invalid email or password." }),
      },
    });
    renderLoginPage();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.invalid" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Invalid email or password.");
    });
  });

  it("reveals the MFA step when the server responds mfa_required", async () => {
    mockFetchByPath({
      "/auth/me": { ok: false, json: () => Promise.resolve({}) },
      "/auth/login": {
        ok: false,
        json: () => Promise.resolve({ error: "mfa_required", message: "Multi-factor authentication code required." }),
      },
    });
    renderLoginPage();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.invalid" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Correct-Horse-Battery-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
  });

  it("switches to a recovery-code field on request", async () => {
    mockFetchByPath({
      "/auth/me": { ok: false, json: () => Promise.resolve({}) },
      "/auth/login": {
        ok: false,
        json: () => Promise.resolve({ error: "mfa_required", message: "Multi-factor authentication code required." }),
      },
    });
    renderLoginPage();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.invalid" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Correct-Horse-Battery-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => screen.getByLabelText("Verification code"));

    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));

    expect(screen.getByLabelText("Recovery code")).toBeInTheDocument();
  });
});
