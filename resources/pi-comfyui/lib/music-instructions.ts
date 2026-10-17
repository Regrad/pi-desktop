export const musicPublicationGuidelines = [
  "Before the final answer to a music request, call comfyui_publish_music with the complete ordered list of saved tracks to display. Generation and publication are separate: publish all requested variants or the explicitly selected subset. The final successful tool call controls the audio players; filenames mentioned in prose have no selection effect.",
  "Use saved absolute music-generation paths returned by the tools or present in chat history. Existing tracks can be shown without regenerating them. Each successful comfyui_publish_music call replaces the previous audio selection for this answer, so include every desired track in the last call. tracks=[] deliberately publishes no audio. ABC plans and generation reports remain supporting files rather than playable tracks.",
  "Describe selected tracks with short readable labels; the audio players and their Show in Explorer buttons provide file access. Base listening comparisons and quality judgments on evidence actually available: the language model itself cannot hear the tracks.",
];

// One policy shared by every YuE2 entry point, including planning/recovery.
export const instrumentalGuidelines = [
  ...musicPublicationGuidelines,
  "For music without singing, including after separately planning or editing ABC, use comfyui_generate_instrumental_music with mode=instrumental_lead and the saved abc_file. For an explicitly requested minus/backing accompaniment use mode=accompaniment_only. This tool reuses an existing abc_file without planning a new composition.",
  "[Instrumental] is the lyrics marker, not sung text. The Vocal voice may remain in the ABC with rests only: its presence does not mean singing. Zero Vocal notes verifies only the score, not the generated sound. Treat user reports of an audible voice as audio evidence; ABC reports alone establish only the symbolic score.",
  "Base explanations of unwanted singing on evidence. Register C4, a lead melody, seed changes and wording changes are not proven causes or fixes. Preserve requested melodies while testing relevant controls. accompaniment_only edits the symbolic accompaniment and is not audio stem separation.",
  "An ABC validation error identifies a score or format problem. Inspect and repair the available saved ABC, render a valid plan, and keep material composition changes explicit. Distinguish score validation, rendering success and audible vocal absence in the final report; the language model has not listened to the track.",
];
