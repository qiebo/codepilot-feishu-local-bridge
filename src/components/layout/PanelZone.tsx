"use client";

import { usePanel } from "@/hooks/usePanel";
import { PreviewPanel } from "./panels/PreviewPanel";
import { GitPanelContainer } from "./panels/GitPanel";
import { FileTreePanel } from "./panels/FileTreePanel";

export function PanelZone() {
  const { previewOpen, previewFile, gitPanelOpen, fileTreeOpen } = usePanel();

  const anyOpen = (previewOpen && !!previewFile) || gitPanelOpen || fileTreeOpen;

  if (!anyOpen) return null;

  return (
    <div className="flex h-full shrink-0 border-l border-border/40 overflow-hidden">
      {previewOpen && previewFile && <PreviewPanel />}
      {gitPanelOpen && <GitPanelContainer />}
      {fileTreeOpen && <FileTreePanel />}
    </div>
  );
}
