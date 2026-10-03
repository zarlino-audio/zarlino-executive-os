import { describe, it, expect } from "vitest";
import { firstNameOf } from "../src/core/outreach";

describe("outreach greeting names", () => {
  it("keeps person names as the first name", () => {
    expect(firstNameOf("Kwame Mensah")).toBe("Kwame");
    expect(firstNameOf("  Jaeye  ")).toBe("Jaeye");
    expect(firstNameOf("")).toBe("there");
  });

  it("greets organisations sensibly instead of truncating them", () => {
    expect(firstNameOf("The Producer School")).toBe("Producer School");
    expect(firstNameOf("House of Amapiano")).toBe("House of Amapiano");
    expect(firstNameOf("The")).toBe("The");
  });
});
