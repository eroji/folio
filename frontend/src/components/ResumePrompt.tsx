/** Cross-device conflict prompt (spec "Progress model"): shown when another
 * device's saved position is more than 60 s ahead of where this device was
 * about to resume. */
export interface ResumePromptProps {
  device: string;
  chapter: string;
  time: string;
  onContinue: () => void;
  onStartHere: () => void;
}

export function ResumePrompt({ device, chapter, time, onContinue, onStartHere }: ResumePromptProps) {
  return (
    <div role="dialog" aria-label="Continue where you left off" className="rounded-lg bg-surface p-4">
      <p className="text-sm">
        Continue from {chapter}, {time} on {device}?
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onContinue}
          className="tap min-h-11 flex-1 rounded-full bg-fg px-4 text-sm font-bold text-on-fg"
        >
          Continue
        </button>
        <button
          type="button"
          onClick={onStartHere}
          className="tap min-h-11 flex-1 rounded-full border border-border px-4 text-sm font-semibold text-fg hover:bg-raised"
        >
          Start here
        </button>
      </div>
    </div>
  );
}
