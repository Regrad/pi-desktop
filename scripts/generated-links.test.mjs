import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGeneratedLink, generatedLinkLabel } from "../shared/generated-links.ts";

const url = `file:///C:/AI/Pi%20Desktop/data/music-generation/${encodeURIComponent("Песня_00081.flac")}`;
test("encoded local media links are recognized and have readable labels", () => {
  assert.deepEqual(parseGeneratedLink(url), { kind: "music", filename: "Песня_00081.flac" });
  assert.equal(generatedLinkLabel(url, url), "Песня_00081.flac");
  assert.equal(generatedLinkLabel(url, "Слушать вариант 1"), "Слушать вариант 1");
});
test("long labels are bounded", () => {
  const long = `file:///C:/data/music-generation/${"a".repeat(100)}.flac`;
  assert.ok(generatedLinkLabel(long, long).length <= 64);
});
test("unsafe schemes, network shares, executables and malformed paths are rejected", () => {
  for (const value of ["javascript:alert(1)", "file://server/data/music-generation/a.flac", "file:///C:/data/music-generation/a.exe", "file:///C:/Temp/a.flac", "file:///C:/data/music-generation/a%2fb.flac", "file:///C:/data/music-generation/%00a.flac", `${url}?x=1`, "file:///C:/data/music-generation/%ZZ.flac"])
    assert.equal(parseGeneratedLink(value), undefined, value);
});
