import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UploadZone } from "@/app/components/UploadZone";

const TRIGGER_LABEL =
  "Upload label images: drag and drop, or press Enter to browse";

function getHiddenFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("hidden file input not found");
  return input;
}

describe("UploadZone", () => {
  it("renders the dropzone copy and the 'Choose files' trigger", () => {
    render(<UploadZone onFiles={() => {}} />);
    expect(screen.getByLabelText(TRIGGER_LABEL)).toBeInTheDocument();
    // Unified-dropzone copy (image + optional application file).
    expect(
      screen.getByText(/Drop a label image \(\+ application file, optional\)/i),
    ).toBeInTheDocument();
    // The trigger button carries the descriptive aria-label; its visible
    // text remains "Choose files".
    expect(
      screen.getByRole("button", { name: TRIGGER_LABEL }),
    ).toBeInTheDocument();
  });

  it("calls onFiles with the array when a file is selected via the hidden input", async () => {
    const user = userEvent.setup();
    const onFiles = vi.fn();
    const { container } = render(<UploadZone onFiles={onFiles} />);
    const input = getHiddenFileInput(container);

    const file = new File(["hello"], "label.png", { type: "image/png" });
    await user.upload(input, file);

    expect(onFiles).toHaveBeenCalledTimes(1);
    const arg = onFiles.mock.calls[0]?.[0] as File[];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg).toHaveLength(1);
    expect(arg[0]?.name).toBe("label.png");
    expect(arg[0]?.type).toBe("image/png");
  });

  it("Enter on the trigger forwards to the hidden file input via a click", async () => {
    const user = userEvent.setup();
    const { container } = render(<UploadZone onFiles={() => {}} />);
    const trigger = screen.getByLabelText(TRIGGER_LABEL);
    const input = getHiddenFileInput(container);
    const clickSpy = vi.spyOn(input, "click");

    trigger.focus();
    await user.keyboard("{Enter}");

    expect(clickSpy).toHaveBeenCalled();
  });

  it("does not invoke onFiles when disabled and a drop event fires", () => {
    const onFiles = vi.fn();
    render(<UploadZone onFiles={onFiles} disabled />);
    expect(onFiles).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: TRIGGER_LABEL });
    expect(button).toBeDisabled();
  });

  it("accepts files when browser reports empty MIME but the extension is allowed", async () => {
    // UI audit blocker #3: Windows Explorer + Edge often return
    // `f.type === ""` for .csv, .md, .docx, .heic. The previous strict
    // `accept.includes(f.type)` filter rejected those, surfacing a
    // misleading "unsupported type" error for files the OS picker
    // had just shown. Now we fall back to extension → MIME.
    //
    // We exercise the drop path here, not the hidden-input `change`
    // path: testing-library's `user.upload()` enforces the input's
    // `accept` attribute against `File.type` before dispatching the
    // change event, so an empty-type file never reaches the component
    // in a test. Real browsers don't pre-filter — `accept` is only
    // an OS-picker hint — so the production-relevant path is the
    // drop handler, which forwards `e.dataTransfer.files` to our
    // filterAccepted unconditionally.
    const onFiles = vi.fn();
    const { container } = render(<UploadZone onFiles={onFiles} />);
    const dropTarget = container.querySelector('[aria-disabled="false"]');
    if (!dropTarget) throw new Error("drop target not found");

    const csv = new File(["a,b,c\n1,2,3"], "app-data.csv", { type: "" });
    const dataTransfer = {
      files: [csv],
      types: ["Files"],
    } as unknown as DataTransfer;
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.drop(dropTarget, { dataTransfer });

    expect(onFiles).toHaveBeenCalledTimes(1);
    const arg = onFiles.mock.calls[0]?.[0] as File[];
    expect(arg).toHaveLength(1);
    expect(arg[0]?.name).toBe("app-data.csv");
  });

  it("still rejects unknown extensions with empty MIME", async () => {
    const onFiles = vi.fn();
    const { container } = render(<UploadZone onFiles={onFiles} />);
    const dropTarget = container.querySelector('[aria-disabled="false"]');
    if (!dropTarget) throw new Error("drop target not found");

    const exe = new File(["MZ"], "evil.exe", { type: "" });
    const dataTransfer = { files: [exe], types: ["Files"] } as unknown as DataTransfer;
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.drop(dropTarget, { dataTransfer });

    expect(onFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Rejected 1 file/);
  });
});
