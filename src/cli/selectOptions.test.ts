import { describe, expect, it } from "vitest";
import { findSelectedOption } from "./selectOptions.js";

describe("findSelectedOption", () => {
  const options = [
    {
      label: "Approve and execute",
      value: "approved",
      aliases: ["approve", "execute"],
    },
    {
      label: "Revise plan",
      value: "revise",
      aliases: ["revision"],
    },
    {
      label: "Cancel task",
      value: "cancelled",
      aliases: ["cancel"],
    },
  ] as const;

  it("matches numbered input", () => {
    expect(findSelectedOption("2", options)?.value).toBe("revise");
  });

  it("matches labels, values, and aliases", () => {
    expect(findSelectedOption("Approve and execute", options)?.value).toBe(
      "approved",
    );
    expect(findSelectedOption("approved", options)?.value).toBe("approved");
    expect(findSelectedOption("cancel", options)?.value).toBe("cancelled");
  });

  it("returns undefined for blank or invalid input", () => {
    expect(findSelectedOption("", options)).toBeUndefined();
    expect(findSelectedOption("later", options)).toBeUndefined();
  });
});
