import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContactImportPage from "./ContactImportPage";

const BATCH_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const UPLOAD_RESPONSE = {
  batch: {
    id: BATCH_ID,
    fileName: "contacts.csv",
    fileType: "csv",
    status: "mapping",
    rowCount: 1,
    headers: ["First Name", "Last Name", "Email"],
    columnMapping: null,
    summary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:30:00.000Z",
    confirmedAt: null,
  },
  sampleRows: [["Jane", "Doe", "jane@example.invalid"]],
  suggestedMapping: [
    { header: "First Name", suggested: "firstName" },
    { header: "Last Name", suggested: "lastName" },
    { header: "Email", suggested: "email" },
  ],
};

const PREVIEW_ROW = {
  id: "row-1",
  rowIndex: 1,
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.invalid",
  mobilePhone: null,
  department: null,
  referenceId: null,
  status: "valid",
  reasons: [],
  duplicateMatches: null,
  selected: true,
  importResult: null,
  importError: null,
};

const PREVIEW_RESPONSE = {
  batch: {
    ...UPLOAD_RESPONSE.batch,
    status: "previewed",
    summary: {
      total: 1,
      valid: 1,
      invalid: 0,
      possibleDuplicate: 0,
      duplicateInFile: 0,
      selected: 1,
      imported: 0,
      skipped: 0,
      failed: 0,
    },
  },
  rows: [PREVIEW_ROW],
  total: 1,
};

const CONFIRM_RESPONSE = {
  summary: {
    total: 1,
    valid: 1,
    invalid: 0,
    possibleDuplicate: 0,
    duplicateInFile: 0,
    selected: 1,
    imported: 1,
    skipped: 0,
    failed: 0,
  },
  results: [
    { rowId: "row-1", rowIndex: 1, displayName: "Jane Doe", status: "valid", importResult: "imported", contactId: "new-contact-id" },
  ],
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
      if (path === "/contacts/import/upload" && method === "POST") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(UPLOAD_RESPONSE) });
      }
      if (path === `/contacts/import/${BATCH_ID}/preview` && method === "POST") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(PREVIEW_RESPONSE) });
      }
      if (path === `/contacts/import/${BATCH_ID}/confirm` && method === "POST") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(CONFIRM_RESPONSE) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

describe("ContactImportPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("walks through upload → map → preview → confirm → results", async () => {
    mockRoutes();
    const onDone = vi.fn();
    render(<ContactImportPage onDone={onDone} />);

    const file = new File(["First Name,Last Name,Email\nJane,Doe,jane@example.invalid\n"], "contacts.csv", {
      type: "text/csv",
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    // Step 2: mapping — auto-suggested mapping should already be applied.
    await screen.findByText(/Map each column/);
    const continueToPreview = await screen.findByRole("button", { name: "Continue to Preview" });
    fireEvent.click(continueToPreview);

    // Step 3: preview shows the valid row and its stats.
    await waitFor(() => {
      expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Continue \(1 selected\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Continue \(1 selected\)/ }));

    // Step 4: confirm.
    await screen.findByText(/You are about to import/);
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Contact/ }));

    // Step 5: results.
    await waitFor(() => {
      expect(screen.getByText("imported")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("shows a duplicate warning row and requires explicit approval to import it", async () => {
    const duplicatePreview = {
      batch: {
        ...PREVIEW_RESPONSE.batch,
        summary: { ...PREVIEW_RESPONSE.batch.summary, valid: 0, possibleDuplicate: 1, selected: 0 },
      },
      rows: [
        {
          ...PREVIEW_ROW,
          status: "possible_duplicate",
          selected: false,
          reasons: ["Matches an existing contact by normalized email or mobile phone."],
          duplicateMatches: [{ id: "existing-id", displayName: "Existing Person", matchedOn: ["email"] }],
        },
      ],
      total: 1,
    };
    mockRoutes({
      [`POST /contacts/import/${BATCH_ID}/preview`]: () => duplicatePreview,
    });
    render(<ContactImportPage onDone={vi.fn()} />);

    const file = new File(["a"], "contacts.csv", { type: "text/csv" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    fireEvent.click(await screen.findByRole("button", { name: "Continue to Preview" }));

    await screen.findByText("Possible duplicate");
    expect(screen.getByRole("button", { name: /Continue \(0 selected\)/ })).toBeDisabled();

    const checkbox = screen.getByRole("checkbox", { name: "Import row 1" });
    fireEvent.click(checkbox);
    expect(screen.getByRole("button", { name: /Continue \(1 selected\)/ })).not.toBeDisabled();
  });
});
