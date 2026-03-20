"use client";

import { CliToolsManager } from "@/components/cli-tools/CliToolsManager";

export default function CliToolsPage() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-hidden p-6 flex flex-col min-h-0">
        <CliToolsManager />
      </div>
    </div>
  );
}
