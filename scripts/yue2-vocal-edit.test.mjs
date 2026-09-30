import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { editYuE2VocalScore } = await import("../electron/yue2-vocal-edit.ts");

const header = 'X:1\nT:\nM:2/4\nL:1/16\nQ:1/4=120\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n';

test("lead mode moves Vocal notes into Ins and retains instrumental intro", () => {
  const source = `${header}% intro\nV: Vocal\nZ|\nV: Ins\nC2D2E2F2|\n% verse\nV: Vocal\n"C"G2A2B2c2|\nV: Ins\nZ|\n`;
  const result = editYuE2VocalScore(source, "instrumental_lead");
  assert.match(result.abc, /V: Ins\n=C2=D2=E2=F2\|/);
  assert.match(result.abc, /V: Ins\n=G2=A2=B2=c2\|/);
  assert.match(result.abc, /"C"z2z2z2z2\|/);
  assert.equal(result.report.vocalNotesAfter, 0);
  assert.equal(result.report.clippedInstrumentalNotes, 0);
});

test("minus mode preserves the existing Ins score and replaces vocal notes with rests", () => {
  const source = `${header}% verse\nV: Vocal\n"C"G2A2B2c2|\nV: Ins\nC2D2E2F2|\n`;
  const result = editYuE2VocalScore(source, "accompaniment_only");
  assert.match(result.abc, /V: Ins\nC2D2E2F2\|/);
  assert.match(result.abc, /"C"z2z2z2z2\|/);
  assert.equal(result.report.instrumentalNotesBefore, result.report.instrumentalNotesAfter);
  assert.equal(result.report.vocalNotesAfter, 0);
});

test("lead mode clips overlapping accompaniment but keeps non-overlapping fills", () => {
  const source = `${header}% verse\nV: Vocal\nz2G2z4|\nV: Ins\nC2D2E2F2|\n`;
  const result = editYuE2VocalScore(source, "instrumental_lead");
  assert.equal(result.report.clippedInstrumentalNotes, 1);
  assert.deepEqual(result.report.affectedInstrumentalNotes, [{
    startUnits: 2, pitchMidi: 62, durationUnits: 2, retainedSegments: [],
  }]);
  assert.match(result.abc, /=C2=G2=E2=F2\|/);
});

test("tied vocal notes remain continuous after transfer", () => {
  const source = `${header}% verse\nV: Vocal\nG8-|G8|\nV: Ins\nZ2|\n`;
  const result = editYuE2VocalScore(source, "instrumental_lead");
  assert.match(result.abc, /V: Ins\n=G8-\|=G8\|/);
  assert.equal(result.report.vocalNotesAfter, 0);
});

test("minus refuses an empty accompaniment and unknown notation", () => {
  const empty = `${header}% verse\nV: Vocal\nG8|\nV: Ins\nZ|\n`;
  assert.throws(() => editYuE2VocalScore(empty, "accompaniment_only"), /инструментальная партия пуста/);
  assert.throws(() => editYuE2VocalScore(empty.replace("G8|", "[CEG]8|"), "instrumental_lead"), /неподдерживаемая нотация/);
});

test("a score already without vocals stays unchanged and is reported as instrumental", () => {
  const source = `${header}% intro\nV: Vocal\nZ|\nV: Ins\nC2D2E2F2|\n`;
  for (const mode of ["instrumental_lead", "accompaniment_only"]) {
    const result = editYuE2VocalScore(source, mode);
    assert.equal(result.abc, source);
    assert.equal(result.report.alreadyInstrumental, true);
    assert.equal(result.report.vocalNotesAfter, 0);
  }
  assert.throws(() => editYuE2VocalScore(source.replace("C2D2E2F2|", "Z|"), "instrumental_lead"), /нет ни вокальной мелодии/);
});

test("ABC tempo with a fractional BPM remains valid after score planning", () => {
  const source = `${header.replace("Q:1/4=120", "Q:1/4=96.5")}% verse\nV: Vocal\nG8|\nV: Ins\nC8|\n`;
  const result = editYuE2VocalScore(source, "instrumental_lead");
  assert.match(result.abc, /Q:1\/4=96\.5/);
  assert.equal(result.report.vocalNotesAfter, 0);
});

test("YuE2 meter changes in both voices survive instrumental conversion", () => {
  const source = `${header}% intro\nV: Vocal\nG8|\nV: Ins\nC8|\n% short bar\nV: Vocal\nM:3/8\nG6|\nV: Ins\nM:3/8\nC6|\n% long bar\nV: Vocal\nM:3/4\nG12|\nV: Ins\nM:3/4\nC12|\n`;
  for (const mode of ["instrumental_lead", "accompaniment_only"]) {
    const result = editYuE2VocalScore(source, mode);
    assert.equal((result.abc.match(/M:3\/8/g) ?? []).length, 2);
    assert.equal((result.abc.match(/M:3\/4/g) ?? []).length, 2);
    assert.equal(result.report.bars, 3);
    assert.equal(result.report.nominalSeconds, 3.25);
    assert.equal(result.report.vocalNotesAfter, 0);
  }
  assert.throws(() => editYuE2VocalScore(source.replace("V: Ins\nM:3/8", "V: Ins\nM:2/4"), "instrumental_lead"), /размеры Vocal и Ins различаются/);
});

test("real local YuE2 scores are accepted without embedding user files in the test suite", async (t) => {
  const files = [
    "C:/AI/ComfyUI/ComfyUI/output/YuE2_ABC/20260929_193038/extended_test_song-full.abc",
    "C:/AI/ComfyUI/ComfyUI/output/YuE2_ABC/20260929_192956/extended_test_cover.abc",
  ].filter(existsSync);
  if (!files.length) return t.skip("No local YuE2 score fixtures");
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const lead = editYuE2VocalScore(source, "instrumental_lead");
    assert.equal(lead.report.vocalNotesAfter, 0);
    if (lead.report.instrumentalNotesBefore) {
      const minus = editYuE2VocalScore(source, "accompaniment_only");
      assert.equal(minus.report.instrumentalNotesBefore, minus.report.instrumentalNotesAfter);
    }
  }
});
