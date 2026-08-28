import { MonitorIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { RunTargetOption } from "./BranchToolbar.logic";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarRunTargetSelectorProps {
  envLocked: boolean;
  value: string;
  options: readonly RunTargetOption[];
  // Absent once the thread has started: the control still renders as a
  // static label so a cloud thread is identifiable at rest.
  onRunTargetChange?: (option: RunTargetOption) => void;
}

/**
 * The glyph for a run target. This machine gets the monitor; a cloud runtime
 * carries its provider's own mark, so the two never read the same.
 */
function RunTargetIcon({ option }: { option: RunTargetOption | null }) {
  if (option?.kind === "cloud") {
    return (
      <ProviderInstanceIcon
        driverKind={option.driverKind}
        displayName={option.label}
        accentColor={option.accentColor}
        className="size-3 shrink-0"
        iconClassName="size-3"
      />
    );
  }
  return <MonitorIcon className="size-3 shrink-0" />;
}

export const BranchToolbarRunTargetSelector = memo(function BranchToolbarRunTargetSelector({
  envLocked,
  value,
  options,
  onRunTargetChange,
}: BranchToolbarRunTargetSelectorProps) {
  const activeOption = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const selectItems = useMemo(
    () => options.map((option) => ({ value: option.value, label: option.label })),
    [options],
  );

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked || onRunTargetChange === undefined) {
    return (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        <RunTargetIcon option={activeOption} />
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            {activeOption?.label ?? "Runs on"}
          </span>
        </span>
      </span>
    );
  }

  const handleValueChange = (nextValue: string) => {
    const next = options.find((option) => option.value === nextValue);
    if (next) onRunTargetChange(next);
  };

  return (
    <Select
      modal={false}
      value={value}
      onValueChange={(next) => handleValueChange(next as string)}
      items={selectItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="min-w-0 max-w-full font-medium"
        aria-label="Runs on"
        data-composer-context-control
      >
        <RunTargetIcon option={activeOption} />
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="inline-flex items-center gap-1.5">
                <RunTargetIcon option={option} />
                {option.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
