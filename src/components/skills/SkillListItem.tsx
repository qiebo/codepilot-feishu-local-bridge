"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { ZapIcon, Delete02Icon, GlobeIcon, Plug01Icon, Download04Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";

export interface SkillItem {
  name: string;
  description: string;
  content: string;
  source: "global" | "project" | "plugin" | "installed";
  installedSource?: "agents" | "claude";
  filePath: string;
}

interface SkillListItemProps {
  skill: SkillItem;
  selected: boolean;
  onSelect: () => void;
  onDelete: (skill: SkillItem) => void;
}

export function SkillListItem({
  skill,
  selected,
  onSelect,
  onDelete,
}: SkillListItemProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete(skill);
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);
      // Auto-reset after 3 seconds
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md px-3 py-2 cursor-pointer transition-colors",
        selected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50"
      )}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setConfirmDelete(false);
      }}
    >
      <HugeiconsIcon icon={ZapIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium truncate block">/{skill.name}</span>
        <p className="text-xs text-muted-foreground truncate">
          {skill.description}
        </p>
      </div>
      {(hovered || confirmDelete) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={confirmDelete ? "destructive" : "ghost"}
              size="icon-xs"
              className="shrink-0"
              onClick={handleDelete}
            >
              <HugeiconsIcon icon={Delete02Icon} className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {confirmDelete ? t('skills.deleteConfirm') : t('common.delete')}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
