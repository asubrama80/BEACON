import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the BEACON application shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { level: 1, name: "BEACON" })).toBeInTheDocument();
    expect(screen.getByText("Application shell is running")).toBeInTheDocument();
  });
});
