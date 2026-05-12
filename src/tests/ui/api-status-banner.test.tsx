import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ApiStatusBanner } from "@/app/components/ApiStatusBanner";

describe("ApiStatusBanner", () => {
  let originalFetch: typeof fetch | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch!;
  });

  function mockFetch(body: object): void {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  }

  it("renders nothing when health says ready with no notes", async () => {
    mockFetch({ ok: true, ready: true, notes: [] });
    const { container } = render(<ApiStatusBanner />);
    // The component starts in "loading" with `null` output and only
    // re-renders to OK (still null) or warn. Allow the promise to
    // settle then assert no banner is in the DOM.
    await waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull());
  });

  it("renders a warning banner when health reports notes", async () => {
    mockFetch({
      ok: true,
      ready: false,
      notes: ["The verification service is missing a required API key."],
    });
    render(<ApiStatusBanner />);
    await waitFor(() =>
      expect(
        screen.getByText(/Service configuration issue/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/missing a required API key/i),
    ).toBeInTheDocument();
  });
});
