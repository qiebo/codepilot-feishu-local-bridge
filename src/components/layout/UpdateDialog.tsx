"use client";

import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useUpdate } from "@/hooks/useUpdate";
import { useTranslation } from "@/hooks/useTranslation";

export function UpdateDialog() {
  const { updateInfo, showDialog, dismissUpdate, downloadUpdate, quitAndInstall } = useUpdate();
  const { t } = useTranslation();

  if (!updateInfo?.updateAvailable) return null;

  const { isNativeUpdate, readyToInstall, downloadProgress } = updateInfo;
  const isDownloading = isNativeUpdate && !readyToInstall && downloadProgress != null;

  return (
    <Dialog open={showDialog} onOpenChange={(open) => {
      if (!open) dismissUpdate();
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('update.newVersionAvailable')}</DialogTitle>
          <DialogDescription>
            {updateInfo.releaseName}
            {updateInfo.publishedAt && (
              <span className="ml-2 text-xs text-muted-foreground">
                {new Date(updateInfo.publishedAt).toLocaleDateString()}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {updateInfo.releaseNotes && (
          <div className="max-h-60 overflow-auto rounded-md border border-border/50 bg-muted/30 p-3 text-sm">
            <ReactMarkdown
              components={{
                h1: ({ children }) => <h3 className="mb-1 text-sm font-semibold">{children}</h3>,
                h2: ({ children }) => <h3 className="mb-1 text-sm font-semibold">{children}</h3>,
                h3: ({ children }) => <h4 className="mb-1 text-sm font-medium">{children}</h4>,
                p: ({ children }) => <p className="mb-2 text-sm leading-relaxed">{children}</p>,
                ul: ({ children }) => <ul className="mb-2 list-disc pl-4 text-sm">{children}</ul>,
                ol: ({ children }) => <ol className="mb-2 list-decimal pl-4 text-sm">{children}</ol>,
                li: ({ children }) => <li className="mb-0.5">{children}</li>,
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">
                    {children}
                  </a>
                ),
                code: ({ children }) => (
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
                ),
              }}
            >
              {updateInfo.releaseNotes}
            </ReactMarkdown>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Current: v{updateInfo.currentVersion} &rarr; Latest: v{updateInfo.latestVersion}
        </p>

        {/* Download progress bar */}
        {isDownloading && (
          <div className="space-y-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-blue-500 transition-all"
                style={{ width: `${Math.min(downloadProgress!, 100)}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('update.downloading')} {Math.round(downloadProgress!)}%
            </p>
          </div>
        )}

        {updateInfo.lastError && (
          <p className="rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
            {updateInfo.lastError}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={dismissUpdate}>
            {t('update.later')}
          </Button>
          {!isNativeUpdate ? (
            <Button
              onClick={() => {
                window.open(updateInfo.releaseUrl, "_blank");
              }}
            >
              {t('settings.viewRelease')}
            </Button>
          ) : readyToInstall ? (
            <Button onClick={quitAndInstall}>
              {t('update.restartToUpdate')}
            </Button>
          ) : isDownloading ? (
            <Button disabled>
              {t('update.downloading')}...
            </Button>
          ) : (
            <Button onClick={downloadUpdate}>
              {t('update.installUpdate')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
