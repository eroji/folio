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
    <div role="dialog" aria-label="Continue where you left off" className="rounded-card border border-line bg-page p-4">
      <p className="text-sm">
        Continue from {chapter}, {time} on {device}?
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onContinue}
          className="min-h-11 flex-1 rounded-pill bg-brand-gradient px-4 text-sm font-semibold text-white"
        >
          Continue
        </button>
        <button
          type="button"
          onClick={onStartHere}
          className="min-h-11 flex-1 rounded-pill border border-line bg-card px-4 text-sm font-medium"
        >
          Start here
        </button>
      </div>
    </div>
  );
}
