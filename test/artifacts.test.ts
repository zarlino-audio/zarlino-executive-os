import { describe, expect, it } from "vitest";
import { artifactKey, artifactSlug, normalizeArtifactPath, MAX_ARTIFACT_BYTES } from "../src/core/artifacts";

describe("artifact storage helpers (R2, mandate §25)", () => {
  it("slugs display names safely and never returns empty", () => {
    expect(artifactSlug("ZTame A/B render.wav")).toBe("ztame-a-b-render.wav");
    expect(artifactSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(artifactSlug("///")).toBe("artifact");
    expect(artifactSlug("")).toBe("artifact");
    expect(artifactSlug("a".repeat(300)).length).toBeLessThanOrEqual(80);
  });

  it("generates keys under the artifacts/ prefix with sanitised kind", () => {
    const at = new Date("2026-09-29T15:20:01.123Z");
    const key = artifactKey("Patch 1.2.zip", "build", at);
    expect(key).toBe("artifacts/build/2026-09-29T15-20-01-123Z-patch-1.2.zip");
    expect(artifactKey("x.wav", "RENDERS").startsWith("artifacts/misc/")).toBe(true); // case rejected → misc
    expect(artifactKey("x.wav", "render").startsWith("artifacts/render/")).toBe(true);
    // A caller cannot escape the prefix via the name.
    expect(artifactKey("../../evil.sh", "misc")).toContain("artifacts/misc/");
    expect(artifactKey("../../evil.sh", "misc")).not.toContain("..");
  });

  it("normalizes valid keys and rejects unsafe or out-of-scope ones", () => {
    expect(normalizeArtifactPath("/artifacts/render/a.wav")).toBe("artifacts/render/a.wav");
    expect(normalizeArtifactPath("artifacts/build/x.zip")).toBe("artifacts/build/x.zip");
    expect(normalizeArtifactPath("artifacts/../secret")).toBeNull();
    expect(normalizeArtifactPath("artifacts/render/..%2f..%2fetc")).toBeNull(); // raw %2f is literal, but ".." is caught
    expect(normalizeArtifactPath("other/prefix.txt")).toBeNull();
    expect(normalizeArtifactPath("")).toBeNull();
    expect(normalizeArtifactPath(undefined)).toBeNull();
    expect(normalizeArtifactPath("artifacts/" + "x".repeat(400))).toBeNull();
    expect(normalizeArtifactPath("artifacts/render/a\\b.wav")).toBeNull();
  });

  it("keeps the single-put cap sane for worker memory", () => {
    expect(MAX_ARTIFACT_BYTES).toBe(25 * 1024 * 1024);
  });
});
