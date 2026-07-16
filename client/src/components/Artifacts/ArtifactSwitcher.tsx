import React, { useState } from 'react';
import { MenuButton } from '@ariakit/react';
import { Files, Check } from 'lucide-react';
import { DropdownPopup, TooltipAnchor, Button, useMediaQuery } from '@librechat/client';
import type { ArtifactGroup } from '~/hooks/Artifacts/useArtifacts';
import { useLocalize } from '~/hooks';

interface ArtifactSwitcherProps {
  groups: ArtifactGroup[];
  currentKey: string | null;
  onSelect: (latestId: string) => void;
}

export default function ArtifactSwitcher({ groups, currentKey, onSelect }: ArtifactSwitcherProps) {
  const localize = useLocalize();
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const menuId = 'artifact-switcher-menu';

  if (groups.length <= 1) {
    return null;
  }

  const dropdownItems = groups.map((group, index) => {
    const isSelected = group.key === currentKey;
    return {
      label: group.title ?? localize('com_ui_artifact_var', { 0: String(index + 1) }),
      onClick: () => {
        onSelect(group.latestId);
        setIsPopoverActive(false);
      },
      value: group.key,
      icon: isSelected ? (
        <Check size={16} className="text-text-primary" aria-hidden="true" />
      ) : undefined,
    };
  });

  return (
    <DropdownPopup
      menuId={menuId}
      portal
      focusLoop
      unmountOnHide
      isOpen={isPopoverActive}
      setIsOpen={setIsPopoverActive}
      trigger={
        <TooltipAnchor
          description={localize('com_ui_switch_artifact')}
          render={
            <Button
              size="icon"
              variant="ghost"
              asChild
              aria-label={localize('com_ui_switch_artifact')}
            >
              <MenuButton>
                <Files
                  size={18}
                  className="text-text-secondary"
                  aria-hidden="true"
                  focusable="false"
                />
              </MenuButton>
            </Button>
          }
        />
      }
      items={dropdownItems}
      className={isSmallScreen ? '' : 'absolute right-0 top-0 mt-2'}
    />
  );
}
