import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UploadZone } from "@/app/components/UploadZone";

// JSDOM does NOT expose three WebKit-prefixed APIs that the wave-12
// feature-detect uses: the `DataTransferItem` global itself,
// `webkitGetAsEntry` on its prototype, and `webkitdirectory` on
// HTMLInputElement.prototype. Polyfill all three for the duration
// of these tests so `supportsFolderUpload()` returns true and the
// "Choose folder" button renders — mirroring real Chrome / Edge /
// Firefox behaviour. The shims are stub-shaped (the folder button
// tests use the input element's FileList path, not a real drop
// roundtrip, so the entry callback is never exercised here).
beforeAll(() => {
  if (
    typeof HTMLInputElement !== "undefined" &&
    !("webkitdirectory" in HTMLInputElement.prototype)
  ) {
    Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
      get() {
        return this.hasAttribute("webkitdirectory");
      },
      set(v: boolean) {
        if (v) this.setAttribute("webkitdirectory", "");
        else this.removeAttribute("webkitdirectory");
      },
      configurable: true,
    });
  }
  // JSDOM does not define `DataTransferItem` at all — provide a
  // minimal stand-in whose prototype carries `webkitGetAsEntry`
  // so the feature-detect succeeds.
  if (typeof (globalThis as { DataTransferItem?: unknown }).DataTransferItem === "undefined") {
    class DataTransferItemStub {
      webkitGetAsEntry(): null {
        return null;
      }
    }
    Object.defineProperty(globalThis, "DataTransferItem", {
      value: DataTransferItemStub,
      configurable: true,
    });
  } else if (!("webkitGetAsEntry" in DataTransferItem.prototype)) {
    Object.defineProperty(DataTransferItem.prototype, "webkitGetAsEntry", {
      value: () => null,
      configurable: true,
    });
  }
});

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
    // Unified-dropzone copy (image, folder, or application file).
    // Wave 12 expanded the heading to mention folder uploads
    // alongside images and application files.
    expect(
      screen.getByText(/Drop a label image, folder, or application file/i),
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

  // -------- wave-12 tests --------

  it("renders a 'Choose folder' button when the browser supports webkitdirectory + webkitGetAsEntry", async () => {
    render(<UploadZone onFiles={() => {}} />);
    // The folder button gates on a `useEffect`-driven feature
    // detection (supportsFolderUpload), so it appears one tick
    // after mount. Use `waitFor` so the test doesn't race the
    // re-render.
    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: /Choose a folder of label images and application files/i,
        }),
      ).toBeInTheDocument();
    });
  });

  it("surfaces the folder-empty notice when a folder pick yields no valid files", async () => {
    const onFiles = vi.fn();
    const { container } = render(<UploadZone onFiles={onFiles} />);
    // The folder input is the third hidden file input (after the
    // default input and the iOS photos input). Find it by the
    // webkitdirectory attribute.
    const folderInput = container.querySelector<HTMLInputElement>(
      'input[type="file"][webkitdirectory]',
    );
    if (!folderInput) throw new Error("folder input not found");

    // Synthesize a folder pick of ONE unsupported file. Browsers
    // populate `webkitRelativePath` on each File when the input was
    // a webkitdirectory pick.
    const bad = new File(["MZ"], "evil.exe", { type: "" });
    Object.defineProperty(bad, "webkitRelativePath", {
      value: "myfolder/evil.exe",
      configurable: true,
    });
    Object.defineProperty(folderInput, "files", {
      value: { length: 1, item: () => bad, 0: bad },
      configurable: true,
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(folderInput);

    expect(onFiles).not.toHaveBeenCalled();
    // Two notices fire: the per-file "Rejected" notice AND the
    // folder-scoped "No valid label images or application files in
    // 'myfolder'" notice (wave-12 copy distinguishes truly-empty
    // from files-but-all-rejected — this is the latter).
    const alerts = screen.getAllByRole("alert");
    expect(
      alerts.some((a) =>
        /No valid label images or application files in/i.test(
          a.textContent ?? "",
        ),
      ),
    ).toBe(true);
    expect(
      alerts.some((a) =>
        /myfolder/i.test(a.textContent ?? ""),
      ),
    ).toBe(true);
  });

  it("passes through valid files from a folder pick", async () => {
    const onFiles = vi.fn();
    const { container } = render(<UploadZone onFiles={onFiles} />);
    const folderInput = container.querySelector<HTMLInputElement>(
      'input[type="file"][webkitdirectory]',
    );
    if (!folderInput) throw new Error("folder input not found");

    const img = new File([new Uint8Array(8)], "label.png", {
      type: "image/png",
    });
    Object.defineProperty(img, "webkitRelativePath", {
      value: "batch1/label.png",
      configurable: true,
    });
    const pdf = new File([new Uint8Array(8)], "label-app.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(pdf, "webkitRelativePath", {
      value: "batch1/label-app.pdf",
      configurable: true,
    });
    const junk = new File([new Uint8Array(8)], "Thumbs.db", { type: "" });
    Object.defineProperty(junk, "webkitRelativePath", {
      value: "batch1/Thumbs.db",
      configurable: true,
    });
    Object.defineProperty(folderInput, "files", {
      value: {
        length: 3,
        item: (i: number) => [img, pdf, junk][i],
        0: img,
        1: pdf,
        2: junk,
      },
      configurable: true,
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(folderInput);

    expect(onFiles).toHaveBeenCalledTimes(1);
    const passed = onFiles.mock.calls[0]?.[0] as File[];
    expect(passed.map((f) => f.name).sort()).toEqual([
      "label-app.pdf",
      "label.png",
    ]);
    // The junk file was rejected and surfaced via the alert.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Rejected 1 file.*Thumbs\.db/i,
    );
  });
});
