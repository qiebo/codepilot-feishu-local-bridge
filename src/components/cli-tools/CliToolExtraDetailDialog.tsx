"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/hooks/useTranslation";
import type { CliToolRuntimeInfo } from "@/types";

interface CliToolExtraDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayName: string;
  runtimeInfo: CliToolRuntimeInfo;
  autoDescription?: { zh: string; en: string };
  locale: string;
}

export function CliToolExtraDetailDialog({
  open,
  onOpenChange,
  displayName,
  runtimeInfo,
  autoDescription,
  locale,
}: CliToolExtraDetailDialogProps) {
  const { t } = useTranslation();
  const isZh = locale === 'zh';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{displayName}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* AI-generated description */}
          {autoDescription && (
            <section>
              <h3 className="text-sm font-medium mb-2">{t('cliTools.detailIntro')}</h3>
              <p className="text-sm text-muted-foreground">
                {isZh ? autoDescription.zh : autoDescription.en}
              </p>
            </section>
          )}

          {/* Runtime info */}
          <section>
            <h3 className="text-sm font-medium mb-2">{t('cliTools.toolInfo')}</h3>
            <div className="text-sm text-muted-foreground space-y-1">
              {runtimeInfo.version && (
                <div className="flex gap-2">
                  <span className="text-foreground/70">{t('cliTools.version')}:</span>
                  <span>{runtimeInfo.version}</span>
                </div>
              )}
              {runtimeInfo.binPath && (
                <div className="flex gap-2">
                  <span className="text-foreground/70 shrink-0">{t('cliTools.path')}:</span>
                  <span className="break-all font-mono text-xs">{runtimeInfo.binPath}</span>
                </div>
              )}
            </div>
          </section>

          {!autoDescription && (
            <p className="text-sm text-muted-foreground italic">
              {t('cliTools.noDescription')}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
