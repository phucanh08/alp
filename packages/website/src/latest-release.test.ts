import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadUrls } from "./downloads";
import {
  getLatestAndroidVersionFromReleases,
  getReleaseChannels,
  selectReleaseChannels,
  type GitHubRelease,
} from "./latest-release";

function release({
  version,
  hasApk,
  prerelease = false,
}: {
  version: string;
  hasApk: boolean;
  prerelease?: boolean;
}): GitHubRelease {
  const tag = `v${version}`;
  return {
    tag_name: tag,
    assets: hasApk ? [{ name: `paseo-${tag}-android.apk` }] : [],
    prerelease,
    draft: false,
  };
}

function desktopRelease({
  version,
  prerelease = false,
  draft = false,
}: {
  version: string;
  prerelease?: boolean;
  draft?: boolean;
}): GitHubRelease {
  return {
    tag_name: `v${version}`,
    assets: [
      { name: `alp-${version}-arm64.dmg` },
      { name: "alp-x86_64.AppImage" },
      { name: `alp-Setup-${version}-x64.exe` },
      { name: `alp-Setup-${version}-arm64.exe` },
    ],
    prerelease,
    draft,
  };
}

describe("getLatestAndroidVersionFromReleases", () => {
  it("selects the latest stable release that contains an Android APK", () => {
    const releases = [
      release({ version: "0.1.109", hasApk: true, prerelease: true }),
      release({ version: "0.1.108", hasApk: false }),
      release({ version: "0.1.107", hasApk: true }),
    ];

    expect(getLatestAndroidVersionFromReleases(releases)).toBe("0.1.107");
  });
});

describe("selectReleaseChannels", () => {
  it("offers the newest prerelease when it leads stable", () => {
    const channels = selectReleaseChannels([
      desktopRelease({ version: "0.3.0-beta.2", prerelease: true }),
      desktopRelease({ version: "0.3.0-beta.1", prerelease: true }),
      desktopRelease({ version: "0.2.5" }),
    ]);

    expect(channels.stable.version).toBe("0.2.5");
    expect(channels.beta?.version).toBe("0.3.0-beta.2");
    expect(channels.beta?.windowsArm64Asset).toBe("alp-Setup-0.3.0-beta.2-arm64.exe");
  });

  it("retires the beta channel once stable ships the same version", () => {
    const channels = selectReleaseChannels([
      desktopRelease({ version: "0.3.0" }),
      desktopRelease({ version: "0.3.0-beta.2", prerelease: true }),
    ]);

    expect(channels.stable.version).toBe("0.3.0");
    expect(channels.beta).toBeNull();
  });

  it("skips drafts and releases whose desktop assets are still uploading", () => {
    const channels = selectReleaseChannels([
      desktopRelease({ version: "0.3.0-beta.3", prerelease: true, draft: true }),
      release({ version: "0.3.0-beta.2", hasApk: true, prerelease: true }),
      desktopRelease({ version: "0.3.0-beta.1", prerelease: true }),
      release({ version: "0.2.5", hasApk: true }),
      desktopRelease({ version: "0.2.4" }),
    ]);

    expect(channels.stable.version).toBe("0.2.4");
    expect(channels.beta?.version).toBe("0.3.0-beta.1");
  });
});

// The asset list of https://github.com/phucanh08/alp/releases/tag/v0.9.2, verbatim.
// It ships desktop builds only: no Android APK.
const ALP_V092_RELEASE: GitHubRelease = {
  tag_name: "v0.9.2",
  prerelease: false,
  draft: false,
  assets: [
    "alp-0.9.2-amd64.deb",
    "alp-0.9.2-arm64.dmg",
    "alp-0.9.2-arm64.dmg.blockmap",
    "alp-0.9.2-arm64.zip",
    "alp-0.9.2-arm64.zip.blockmap",
    "alp-0.9.2-x64.dmg",
    "alp-0.9.2-x64.dmg.blockmap",
    "alp-0.9.2-x64.tar.gz",
    "alp-0.9.2-x64.zip",
    "alp-0.9.2-x64.zip.blockmap",
    "alp-0.9.2-x86_64.rpm",
    "alp-Setup-0.9.2-arm64.exe",
    "alp-Setup-0.9.2-arm64.exe.blockmap",
    "alp-Setup-0.9.2-arm64.zip",
    "alp-Setup-0.9.2-x64.exe",
    "alp-Setup-0.9.2-x64.exe.blockmap",
    "alp-Setup-0.9.2-x64.zip",
    "alp-Setup-0.9.2.exe",
    "alp-Setup-0.9.2.exe.blockmap",
    "alp-x86_64.AppImage",
    "latest-linux.yml",
    "latest-mac.yml",
    "latest.yml",
  ].map((name) => ({ name })),
};

const ALP_RELEASES_API = "https://api.github.com/repos/phucanh08/alp/releases?per_page=10";
const ALP_DOWNLOAD = "https://github.com/phucanh08/alp/releases/download/v0.9.2";

describe("alp fork releases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("links every desktop download to a real v0.9.2 asset and offers no APK", () => {
    const { stable, beta } = selectReleaseChannels([ALP_V092_RELEASE]);

    expect(stable).toEqual({
      version: "0.9.2",
      linuxAppImageAsset: "alp-x86_64.AppImage",
      windowsX64Asset: "alp-Setup-0.9.2-x64.exe",
      windowsArm64Asset: "alp-Setup-0.9.2-arm64.exe",
      androidApkAsset: null,
    });
    expect(beta).toBeNull();
    expect(downloadUrls(stable)).toEqual({
      macAppleSilicon: `${ALP_DOWNLOAD}/alp-0.9.2-arm64.dmg`,
      macIntel: `${ALP_DOWNLOAD}/alp-0.9.2-x64.dmg`,
      linuxAppImage: `${ALP_DOWNLOAD}/alp-x86_64.AppImage`,
      linuxDeb: `${ALP_DOWNLOAD}/alp-0.9.2-amd64.deb`,
      linuxRpm: `${ALP_DOWNLOAD}/alp-0.9.2-x86_64.rpm`,
      windowsExeX64: `${ALP_DOWNLOAD}/alp-Setup-0.9.2-x64.exe`,
      windowsExeArm64: `${ALP_DOWNLOAD}/alp-Setup-0.9.2-arm64.exe`,
      androidApk: null,
    });
  });

  it("reports no Android version instead of failing when no release has an APK", () => {
    expect(getLatestAndroidVersionFromReleases([ALP_V092_RELEASE])).toBeNull();
  });

  it("refetches from the fork instead of serving release data cached from upstream", async () => {
    const upstreamChannels = {
      stable: {
        version: "0.1.70",
        linuxAppImageAsset: "Paseo-0.1.70-x86_64.AppImage",
        windowsX64Asset: "Paseo-Setup-0.1.70-x64.exe",
        windowsArm64Asset: "Paseo-Setup-0.1.70-arm64.exe",
      },
      beta: null,
    };
    const stored = new Map<string, string>();
    const cache = {
      // Whatever key the site asks for, KV still holds a fresh upstream value.
      get: async (key: string) =>
        stored.has(key)
          ? JSON.parse(stored.get(key)!)
          : { fetchedAt: Date.now(), value: upstreamChannels },
      put: async (key: string, value: string) => {
        stored.set(key, value);
      },
    } as unknown as KVNamespace;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      String(input) === ALP_RELEASES_API
        ? new Response(JSON.stringify([ALP_V092_RELEASE]), { status: 200 })
        : new Response("unexpected repository", { status: 404 }),
    );

    const channels = await getReleaseChannels({ cache, waitUntil: () => undefined });

    expect(channels.stable.version).toBe("0.9.2");
    expect(channels.stable.linuxAppImageAsset).toBe("alp-x86_64.AppImage");
  });
});
