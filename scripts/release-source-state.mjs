export function assertReleaseSourceState({ gitDirty, sourceOnly }) {
  if (!gitDirty) return;
  const mode = sourceOnly ? "source-only" : "live-artifact";
  throw new Error(
    `release gate failed: ${mode} verification requires the post-build candidate worktree to remain clean`,
  );
}
