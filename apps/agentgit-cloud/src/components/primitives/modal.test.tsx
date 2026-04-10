import { useState } from "react";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfirmModal, Modal } from "@/components/primitives/modal";

function ModalHarness({
  backdropCloses,
  dismissible,
  initialOpen = true,
}: {
  backdropCloses?: boolean;
  dismissible?: boolean;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);

  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        open modal
      </button>
      <Modal
        backdropCloses={backdropCloses}
        description="Body description"
        dismissible={dismissible}
        onClose={() => setOpen(false)}
        open={open}
        title="Modal title"
      >
        <button type="button">first inside</button>
        <button type="button">second inside</button>
        <button type="button">third inside</button>
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("renders nothing when open=false", () => {
    render(
      <Modal onClose={() => {}} open={false} title="Closed">
        Hidden body
      </Modal>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Hidden body")).toBeNull();
  });

  it("renders the title, description, and dialog role when open=true", () => {
    render(
      <Modal description="Body description" onClose={() => {}} open title="Modal title">
        Body
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Modal title")).toBeInTheDocument();
    expect(screen.getByText("Body description")).toBeInTheDocument();
    expect(screen.getByText("Body")).toBeInTheDocument();
  });

  it("wires aria-labelledby and aria-describedby to the title and description", () => {
    render(
      <Modal description="Some help" onClose={() => {}} open title="Section">
        Body
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");
    const labelledById = dialog.getAttribute("aria-labelledby");
    const describedById = dialog.getAttribute("aria-describedby");
    expect(labelledById).toBeTruthy();
    expect(describedById).toBeTruthy();
    expect(document.getElementById(labelledById!)?.textContent).toBe("Section");
    expect(document.getElementById(describedById!)?.textContent).toBe("Some help");
  });

  it("calls onClose when Escape is pressed and dismissible defaults true", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal onClose={onClose} open title="Closeable">
        <button type="button">inside</button>
      </Modal>,
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose on Escape when dismissible=false", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal dismissible={false} onClose={onClose} open title="Locked">
        <button type="button">inside</button>
      </Modal>,
    );

    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when the backdrop is clicked by default", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close modal backdrop" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not close on backdrop click when backdropCloses=false", async () => {
    const user = userEvent.setup();
    render(<ModalHarness backdropCloses={false} />);

    await user.click(screen.getByRole("button", { name: "Close modal backdrop" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("hides the X close button when dismissible=false", () => {
    render(
      <Modal dismissible={false} onClose={() => {}} open title="Locked">
        <button type="button">inside</button>
      </Modal>,
    );

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("renders an action footer when actions are supplied", () => {
    render(
      <Modal
        actions={
          <button type="button">Save changes</button>
        }
        onClose={() => {}}
        open
        title="With actions"
      >
        Body
      </Modal>,
    );

    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("traps Tab focus inside the dialog (forward)", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    // Focus should land on the first focusable. The header Close button
    // is focusable too, so it gets first dibs.
    const closeButton = screen.getByRole("button", { name: "Close" });
    closeButton.focus();
    expect(closeButton).toHaveFocus();

    // Tab through the inside buttons. The trap should keep focus inside
    // the dialog regardless of how many tabs we issue.
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("traps Shift+Tab focus inside the dialog (backward)", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    const closeButton = screen.getByRole("button", { name: "Close" });
    closeButton.focus();

    await user.tab({ shift: true });
    await user.tab({ shift: true });
    await user.tab({ shift: true });

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("ConfirmModal", () => {
  it("disables the confirm button until the typed text matches the literal", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal
        confirmLabel="Delete branch"
        destructive
        onClose={() => {}}
        onConfirm={onConfirm}
        open
        title="Delete branch?"
        typeToConfirm="delete"
      />,
    );

    const confirm = screen.getByRole("button", { name: "Delete branch" });
    const input = screen.getByLabelText("Type delete to confirm");

    // Initially disabled — nothing typed.
    expect(confirm).toBeDisabled();

    // Partial match still disables.
    await user.type(input, "del");
    expect(confirm).toBeDisabled();

    // Full match enables. Clear first to avoid relying on userEvent's
    // append-vs-replace semantics, which differ subtly between jsdom
    // and a real browser when controlled inputs are involved.
    await user.clear(input);
    await user.type(input, "delete");
    expect(confirm).not.toBeDisabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not require typing when typeToConfirm is omitted", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal
        confirmLabel="OK"
        onClose={() => {}}
        onConfirm={onConfirm}
        open
        title="Are you sure?"
      />,
    );

    const confirm = screen.getByRole("button", { name: "OK" });
    expect(confirm).not.toBeDisabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not call onConfirm while pending=true even if matched", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal
        confirmLabel="Wipe"
        destructive
        onClose={() => {}}
        onConfirm={onConfirm}
        open
        pending
        title="Wipe data?"
        typeToConfirm="wipe"
      />,
    );

    await user.type(screen.getByLabelText("Type wipe to confirm"), "wipe");
    const confirm = screen.getByRole("button", { name: "Wipe" });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses backdropCloses=false when typeToConfirm is supplied (form modal)", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal
        confirmLabel="Delete"
        destructive
        onClose={onClose}
        onConfirm={() => {}}
        open
        title="Delete?"
        typeToConfirm="delete"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Close modal backdrop" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
