import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface ArtifactVersionProps {
  currentIndex: number;
  totalVersions: number;
  onVersionChange: (index: number) => void;
}

export default function ArtifactVersion({
  currentIndex,
  totalVersions,
  onVersionChange,
}: ArtifactVersionProps) {
  const localize = useLocalize();

  if (totalVersions <= 1) {
    return null;
  }

  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < totalVersions - 1;

  return (
    <div
      role="group"
      aria-label={localize('com_ui_versions')}
      className="flex items-center gap-0.5"
    >
      <TooltipAnchor
        description={localize('com_ui_previous_version')}
        render={
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9"
            disabled={!hasPrevious}
            onClick={() => onVersionChange(currentIndex - 1)}
            aria-label={localize('com_ui_previous_version')}
          >
            <ChevronLeft size={16} aria-hidden="true" focusable="false" />
          </Button>
        }
      />
      <span className="min-w-[3.5rem] text-center text-xs tabular-nums text-text-secondary">
        {localize('com_ui_version_count', {
          0: String(currentIndex + 1),
          1: String(totalVersions),
        })}
      </span>
      <TooltipAnchor
        description={localize('com_ui_next_version')}
        render={
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9"
            disabled={!hasNext}
            onClick={() => onVersionChange(currentIndex + 1)}
            aria-label={localize('com_ui_next_version')}
          >
            <ChevronRight size={16} aria-hidden="true" focusable="false" />
          </Button>
        }
      />
    </div>
  );
}
