/** A Test button's outcome line (admin pages), and the hook that runs a test
 * and turns a failed request into a failed result. */
import { useState } from "react";
import clsx from "clsx";
import type { TestResult } from "../api/integrations";
import { Icon } from "./Icon";

export function TestResultLine({ result, label }: { result: TestResult | null; label: string }) {
  if (!result) return null;
  return (
    <p
      role="status"
      aria-label={label}
      className={clsx("flex items-start gap-1.5 text-sm", result.ok ? "text-fg" : "text-danger")}
    >
      <Icon name={result.ok ? "CircleCheck" : "TriangleAlert"} size={16} className="mt-0.5 shrink-0" />
      <span>{result.message}</span>
    </p>
  );
}

export function useTest<T extends TestResult>() {
  const [result, setResult] = useState<T | null>(null);
  const [running, setRunning] = useState(false);
  async function run(call: () => Promise<T>) {
    setRunning(true);
    setResult(null);
    try {
      setResult(await call());
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : "The test failed." } as T);
    } finally {
      setRunning(false);
    }
  }
  return { result, running, run };
}

export const adminInput =
  "tap h-10 w-full rounded-md border border-border bg-raised px-3.5 text-md text-fg placeholder:text-fg-2";
export const adminOutlinePill =
  "tap inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-transparent px-4 text-base font-semibold text-fg hover:bg-raised disabled:opacity-50";
export const adminSavePill =
  "tap inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-fg px-[18px] text-base font-bold text-on-fg hover:opacity-90 disabled:opacity-50";
export const adminLabel = "text-[13px] font-semibold";
export const adminHint = "text-sm text-fg-2";
