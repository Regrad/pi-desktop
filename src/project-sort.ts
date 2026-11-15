import type { ConversationRecord, ProjectRecord } from "../shared/types";

export type ProjectSortMode = "activity" | "alphabet" | "created";
export const PROJECT_SORT_MODES: readonly ProjectSortMode[] = ["activity", "alphabet", "created"];
const STORAGE_KEY = "pi-project-sort";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    // A blocked storage area must not break the sidebar.
    return undefined;
  }
}

export function readProjectSortMode(): ProjectSortMode {
  const saved = storage()?.getItem(STORAGE_KEY);
  return PROJECT_SORT_MODES.includes(saved as ProjectSortMode) ? saved as ProjectSortMode : "activity";
}

export function writeProjectSortMode(mode: ProjectSortMode): void {
  try {
    storage()?.setItem(STORAGE_KEY, mode);
  } catch {
    // The sidebar keeps working with the in-memory choice.
  }
}

/** Newest message in the project, or when the project appeared if it has no chats. */
export function projectActivityAt(project: ProjectRecord, conversations: ConversationRecord[]): string {
  let latest = project.addedAt;
  for (const conversation of conversations) {
    if (conversation.projectId !== project.id || conversation.archived) continue;
    if (conversation.updatedAt > latest) latest = conversation.updatedAt;
  }
  return latest;
}

export function sortProjects(
  projects: ProjectRecord[],
  conversations: ConversationRecord[],
  mode: ProjectSortMode,
): ProjectRecord[] {
  const activity = mode === "activity"
    ? new Map(projects.map(project => [project.id, projectActivityAt(project, conversations)]))
    : undefined;
  return [...projects].sort((a, b) => {
    if (mode === "alphabet") {
      const byName = a.name.localeCompare(b.name, "ru", { sensitivity: "base" });
      // Projects sharing a name keep the order the other modes agree on.
      return byName !== 0 ? byName : b.addedAt.localeCompare(a.addedAt);
    }
    if (mode === "created") {
      const byCreation = b.addedAt.localeCompare(a.addedAt);
      return byCreation !== 0 ? byCreation : a.name.localeCompare(b.name, "ru", { sensitivity: "base" });
    }
    const byActivity = (activity?.get(b.id) ?? "").localeCompare(activity?.get(a.id) ?? "");
    return byActivity !== 0 ? byActivity : b.addedAt.localeCompare(a.addedAt);
  });
}
