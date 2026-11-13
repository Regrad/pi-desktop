# Interface localization

Pi Desktop supports `en` and `ru`. English is the default, including for existing installations with no saved preference. The desktop preference is stored in `desktop-state.json`; browser preferences belong to the browser device's local storage.

`shared/ui-catalog.ts` contains application-owned Russian source strings and their English translations. `shared/interface-language.ts` performs interpolation without recursively translating values. Add a catalog entry whenever adding interface text. Keep `{0}`, `{1}`, and other placeholders identical in both languages.

Renderer components use `t()` from `src/i18n.ts`. The app and image preview provider subscribe to language changes; changing language rerenders the interface without remounting the app or clearing drafts. Do not evaluate translations in module-level constants. Keep source keys in static maps and call `t()` when rendering them.

Native dialogs and image context menus read the current language from the data store. Changing the preference does not restart engine workers or change model prompts. User messages, model responses, project names, skill instructions, and third-party extension output keep their original content. New-chat placeholders carry a separate marker so actual chat titles are not translated.

Run the catalog and persistence tests with `node --test scripts/interface-language.test.mjs`. After `npm run build`, run `npx electron scripts/interface-language-smoke.cjs` to verify both languages, draft preservation, unchanged user content, and saved preferences in the real renderer.

The screenshot option `--capture-readme` uses fixture IPC and a fresh profile. It must never bootstrap from the installed application's data folder. The screenshot is a real render of fictional demo content, not a record of work performed by a model.
