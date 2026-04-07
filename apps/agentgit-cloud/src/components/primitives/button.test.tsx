import { render, screen } from "@testing-library/react";

import { Button } from "@/components/primitives";

describe("Button", () => {
  it("renders the label and default button type", () => {
    render(<Button>Approve action</Button>);

    const button = screen.getByRole("button", { name: "Approve action" });
    expect(button.getAttribute("type")).toBe("button");
  });
});
