---
name: maintain-skills
description: Create, revise or remove reusable Pi Desktop skills when the user asks. Not for ordinary project changes, notebook entries or automatic recording after a task.
---

# Maintain skills

Create or change skills only at the user's request. First inspect the relevant workflow, evidence and existing skills. Reuse or revise a matching skill instead of creating a duplicate. Keep the user's scope and permissions unchanged.

Discover `manage_skills` through codemode and list the catalog. Choose the user scope for reusable instructions across projects, or project scope for this project's workflow. Use the returned roots and paths; never guess a portable installation path. Bundled and external skills are read-only here: create a distinctly named user/project skill if the user needs a variant.

Each skill is a folder named in lowercase kebab-case (up to 64 characters), containing UTF-8 `SKILL.md` with YAML `name` matching the folder and a concise `description` explaining when it applies. Write only useful instructions that change how the task is performed. Skills are not logs, plans or notebooks: current addresses, credentials and progress belong in the notebook. Do not duplicate general system rules or create skills after routine work without a request.

Keep the entrypoint short and self-contained. Add scripts, references or assets only when they help this workflow; link references and explain when to read them. Resolve relative paths against the skill folder. Do not load all references in advance. Instructions never grant permission to perform additional actions.

Create files with the normal write tool and revise them with targeted edit operations. Validate and refresh through `manage_skills` afterward. Test scripts and meaningful behavior when applicable; YAML validation alone does not prove the instructions are useful. For deletion, inspect the exact skill and its resources and obtain the user's authorization before calling delete with its current revision and confirm=true.

Report the saved scope, path and checks briefly. A changed skill must be reread before use; disabled or removed skills must not remain active just because an older version exists in history.
