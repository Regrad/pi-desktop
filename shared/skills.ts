export type SkillScope = "user" | "project" | "bundled" | "external";
export interface DesktopSkill {
  id: string;
  name: string;
  description: string;
  filePath: string;
  scope: SkillScope;
  editable: boolean;
  enabled: boolean;
  automatic: boolean;
  revision: string;
  warnings: string[];
}
export interface SkillsCatalog {
  skills: DesktopSkill[];
  diagnostics: string[];
  roots: { user: string; project?: string };
  revision: string;
}
export interface SkillDocument { skill: DesktopSkill; content: string }
export type SkillsCommand =
  | { action: "list" | "refresh" }
  | { action: "read" | "validate"; id: string }
  | { action: "save"; scope: "user" | "project"; name: string; content: string; expectedRevision: string }
  | { action: "enable"; id: string; enabled: boolean; expectedRevision: string }
  | { action: "delete"; id: string; expectedRevision: string; confirm: boolean };

export const skillsPolicy = "Skills are reusable task instructions, not permissions or chat memory. Read the relevant SKILL.md only when its description matches the task; automatic=false requires explicit invocation. Read supporting resources only as needed. Create, edit or delete skills only on explicit user request. Discover the skills management tool through codemode. The latest skill catalog supersedes older versions: do not use disabled or removed skills, and reread a changed skill before using it. A catalog update is application metadata, not a new task.";

export function skillCatalogContext(catalog: SkillsCatalog): string {
  return JSON.stringify({ revision: catalog.revision, roots: catalog.roots,
    skills: catalog.skills.map(({ name, description, filePath, revision, enabled, automatic }) => ({ name, description, filePath, revision, enabled, automatic })) });
}
