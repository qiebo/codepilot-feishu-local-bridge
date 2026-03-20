import { NextResponse } from "next/server";

const GITHUB_REPO = "op7418/CodePilot";

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function GET() {
  try {
    const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";

    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github.v3+json" },
        next: { revalidate: 300 },
      }
    );

    if (!res.ok) {
      return NextResponse.json(
        { error: "Failed to fetch release info" },
        { status: 502 }
      );
    }

    const release = await res.json();
    const latestVersion = (release.tag_name || "").replace(/^v/, "");
    const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;

    return NextResponse.json({
      latestVersion,
      currentVersion,
      updateAvailable,
      releaseName: release.name || `v${latestVersion}`,
      releaseNotes: release.body || "",
      publishedAt: release.published_at || "",
      releaseUrl: release.html_url || "",
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to check for updates" },
      { status: 500 }
    );
  }
}
