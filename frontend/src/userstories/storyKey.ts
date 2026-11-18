// A user story's key: the first three letters or digits of its project's name,
// in capitals, then the story number padded to three digits ("Sample" + 4 →
// "SAM004"). A story with no project (or whose project name has no letters or
// digits) gets "NON" ("NON004"). Short names are used as they are ("QA" + 4 →
// "QA004"); numbers past 999 just run longer ("SAM1000").
export const NO_PROJECT_PREFIX = "NON";

export function storyKey(
  storyNumber: number,
  projectName: string | null | undefined
): string {
  const prefix =
    (projectName ?? "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 3)
      .toUpperCase() || NO_PROJECT_PREFIX;
  return `${prefix}${String(storyNumber).padStart(3, "0")}`;
}
