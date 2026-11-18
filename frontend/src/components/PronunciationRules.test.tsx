import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PronunciationRules } from "./PronunciationRules";
import { DeliveryNote } from "./DeliveryNote";
import type { PronunciationRule, RulesResponse } from "../api/pronunciation";
import { makeBook } from "../test/player";

const BOOK = "b1";
let listing: RulesResponse;
const calls: { url: string; method: string; body: unknown }[] = [];

const rule = (over: Partial<PronunciationRule>): PronunciationRule => ({
  id: "r",
  match: "x",
  say: "y",
  whole_word: true,
  after_number: false,
  case_sensitive: false,
  ...over,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls.length = 0;
  listing = {
    items: [
      rule({ id: "own", match: "Aoife", say: "Ee-fa" }),
      rule({ id: "s1", match: "Siobhan", say: "Shiv-awn", suggested: true }),
      rule({ id: "s2", match: "Dún Laoghaire", say: "Dun Leery", suggested: true }),
    ],
    can_suggest: true,
    suggesting: false,
    style_prompts: false,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/pronunciation/suggest")) {
        listing = { ...listing, suggesting: true };
        return json(202, { job_id: "j1" });
      }
      const one = url.match(/\/pronunciation\/([^/]+)$/);
      if (one && method === "PATCH") {
        const item = listing.items.find((r) => r.id === one[1])!;
        Object.assign(item, body);
        return json(200, { rule: item });
      }
      if (one && method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/pronunciation")) return json(200, listing);
      if (url.endsWith(`/books/${BOOK}`) && method === "PATCH")
        return json(200, { book: { ...makeBook(), id: BOOK, delivery_note: body.delivery_note, locked_fields: ["delivery_note"] } });
      return json(404, { error: { code: "not_found", message: "nope" } });
    }),
  );
});

function renderWith(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("PronunciationRules suggestions", () => {
  it("lists suggestions apart from the owner's rules, to accept or dismiss", async () => {
    renderWith(<PronunciationRules bookId={BOOK} />);
    const box = await screen.findByRole("region", { name: "Suggested rules" });
    expect(within(box).getByText("Suggested · 2")).toBeTruthy();
    expect(within(box).getByText("Siobhan")).toBeTruthy();
    // The owner's own rule stays in the editable list above.
    expect(screen.getByLabelText("Match 1")).toHaveProperty("value", "Aoife");
    expect(screen.queryByLabelText("Match 2")).toBeNull();

    fireEvent.click(within(box).getByRole("button", { name: "Accept Siobhan" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/s1"))).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ suggested: false });
    await waitFor(() => expect(screen.getByLabelText("Match 2")).toHaveProperty("value", "Siobhan"));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Dún Laoghaire" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Suggested rules" })).toBeNull());
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/s2"))).toBe(true);
  });

  it("asks the language model for suggestions and shows it is working", async () => {
    renderWith(<PronunciationRules bookId={BOOK} />);
    fireEvent.click(await screen.findByRole("button", { name: "Suggest rules" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Suggesting…" })).toHaveProperty("disabled", true));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pronunciation/suggest"))).toBe(true);
  });

  it("offers no Suggest button without a language model", async () => {
    listing = { ...listing, can_suggest: false };
    renderWith(<PronunciationRules bookId={BOOK} />);
    await screen.findByRole("region", { name: "Suggested rules" });
    expect(screen.queryByRole("button", { name: "Suggest rules" })).toBeNull();
  });
});

describe("DeliveryNote", () => {
  it("saves the note and says when the engine will not receive it", async () => {
    renderWith(<DeliveryNote book={{ ...makeBook(), id: BOOK, delivery_note: "Quiet and coastal." }} />);
    const box = screen.getByLabelText("Delivery note");
    expect((box as HTMLTextAreaElement).value).toBe("Quiet and coastal.");
    expect(await screen.findByText(/Kept, but not sent/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save note" })).toHaveProperty("disabled", true);
    fireEvent.change(box, { target: { value: "  Brisk and bright.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH" && c.url.endsWith(`/books/${BOOK}`))?.body).toEqual({
        delivery_note: "Brisk and bright.",
      }),
    );
  });
});
