// Conservative editor for the two-voice native YuE2/SheetSage2 ABC dialect.
// Unknown notation fails closed; a malformed score must never become a new song.
export type VocalEditMode = "instrumental_lead" | "accompaniment_only";

type Note = { start: number; duration: number; pitch: number; id: number };
type Token = { raw: string; kind: "chord" | "note" | "rest"; duration: number };
type Bar = { start: number; length: number; notes: Note[]; tokens: Token[] };
type Voice = { time: number; bars: Bar[]; notes: Note[]; pending?: { pitch: number; written: number; id: number } };
type Group = { vocalLine: number; instrumentalLine: number; vocalBars: Bar[]; instrumentalBars: Bar[] };
type Parsed = { lines: string[]; trailingNewline: boolean; newline: string; groups: Group[]; vocal: Voice; instrumental: Voice; unit: number; bpm: number; meterChanges: string[] };

const naturals: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const majorKeys = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const minorKeys = ["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m"];
const tokenPattern = /"[^"\n]*"|(?:(?:\^\^|__|\^|_|=)?[A-Ga-gz][,']*\d*-?)/y;
const notePattern = /^(\^\^|__|\^|_|=)?([A-Ga-gz])([,']*)(\d*)(-?)$/;
const durations = [48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1];

function invalid(message: string): never { throw new Error(`YuE2 ABC: ${message}`); }

function keySignature(key: string): Record<string, number> {
  const major = majorKeys.indexOf(key);
  const minor = minorKeys.indexOf(key);
  if (major < 0 && minor < 0) invalid(`неподдерживаемая тональность K:${key}`);
  const count = major >= 0 ? major - 7 : minor - 7;
  const signature = Object.fromEntries(Object.keys(naturals).map(letter => [letter, 0])) as Record<string, number>;
  const order = count > 0 ? "FCGDAEB" : "BEADGCF";
  for (const letter of order.slice(0, Math.abs(count))) signature[letter] = Math.sign(count);
  return signature;
}

function meterLength(value: string, unit: number): number {
  const meter = /^M:(\d+)\/(\d+)$/.exec(value);
  if (!meter) invalid(`неподдерживаемый размер ${value}`);
  const beats = Number(meter[1]), denominator = Number(meter[2]);
  if (!Number.isInteger(beats) || beats < 1 || beats > 32 || ![1, 2, 4, 8, 16, 32].includes(denominator)) invalid(`неподдерживаемый размер ${value}`);
  const length = beats * unit / denominator;
  if (!Number.isInteger(length) || length < 1 || length > 1024) invalid(`размер ${value} не выражается целым числом единиц L`);
  return length;
}

function parseScore(text: string): Parsed {
  if (text.length > 1024 * 1024) invalid("нотный план больше 1 МБ");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines.length < 12 || lines[0] !== "X:1" || lines[1] !== "T:") invalid("нужен штатный двухголосный ABC YuE2/SheetSage2");
  const unit = /^L:1\/(\d+)$/.exec(lines[3] ?? "");
  const tempo = /^Q:1\/4=(\d+(?:\.\d+)?)$/.exec(lines[4] ?? "");
  if (!unit || !tempo || !/^V:\s*Vocal\b/.test(lines[5] ?? "") || !/^V:\s*Ins\b/.test(lines[6] ?? "") || !/^K:/.test(lines[7] ?? "")) invalid("неподдерживаемый заголовок ABC");
  const unitDenominator = Number(unit[1]), bpm = Number(tempo[1]);
  if (![8, 16, 32, 64, 128].includes(unitDenominator) || !Number.isFinite(bpm) || bpm < 1 || bpm > 600) invalid("неподдерживаемая единица длительности или темп");
  let barLength = meterLength(lines[2] ?? "", unitDenominator);
  const signature = keySignature(lines[7].slice(2));
  const vocal: Voice = { time: 0, bars: [], notes: [] };
  const instrumental: Voice = { time: 0, bars: [], notes: [] };
  const groups: Group[] = [];
  const meterChanges: string[] = [];
  let nextId = 1;

  function parseLine(line: string, voice: Voice, label: string): Bar[] {
    if (!line.endsWith("|")) invalid(`${label}: строка должна оканчиваться обычной тактовой чертой`);
    const parts = line.slice(0, -1).split("|");
    const bars: Bar[] = [];
    for (const part of parts) {
      const raw = part.trim();
      if (!raw) invalid(`${label}: пустой такт или повторная тактовая черта`);
      const wholeRest = /^Z([2-4])?$/.exec(raw);
      if (wholeRest) {
        if (voice.pending) invalid(`${label}: лига переходит в паузу`);
        for (let i = 0; i < Number(wholeRest[1] ?? 1); i++) {
          const bar: Bar = { start: voice.time, length: barLength, notes: [], tokens: [{ raw: "Z", kind: "rest", duration: barLength }] };
          bars.push(bar); voice.bars.push(bar); voice.time += barLength;
        }
        continue;
      }
      let cursor = 0, offset = 0;
      const local: Record<string, number> = {};
      const notes: Note[] = [], tokens: Token[] = [];
      while (cursor < raw.length) {
        if (/\s/.test(raw[cursor])) { cursor++; continue; }
        tokenPattern.lastIndex = cursor;
        const match = tokenPattern.exec(raw);
        if (!match) invalid(`${label}: неподдерживаемая нотация около «${raw.slice(cursor, cursor + 16)}»`);
        cursor = tokenPattern.lastIndex;
        const value = match[0];
        if (value.startsWith('"')) {
          tokens.push({ raw: value, kind: "chord", duration: 0 });
          continue;
        }
        const note = notePattern.exec(value);
        if (!note) invalid(`${label}: некорректная нота ${value}`);
        const [, accidental, letter, octave, length, tie] = note;
        const duration = Number(length || 1);
        if (!Number.isSafeInteger(duration) || duration < 1 || offset + duration > barLength) invalid(`${label}: неверная длительность ${value}`);
        if (letter === "z") {
          if (accidental || octave || tie || voice.pending) invalid(`${label}: некорректная пауза или лига`);
          tokens.push({ raw: value, kind: "rest", duration });
        } else {
          if (octave.includes(",") && octave.includes("'")) invalid(`${label}: смешаны обозначения октавы`);
          const upper = letter.toUpperCase();
          const written = 60 + naturals[upper] + (letter === upper ? 0 : 12) + 12 * (octave.split("'").length - 1 - (octave.split(",").length - 1));
          const alteration = accidental ? ({ "=": 0, "^": 1, "^^": 2, "_": -1, "__": -2 } as Record<string, number>)[accidental] : (local[upper] ?? signature[upper]);
          if (accidental) local[upper] = alteration;
          let pitch = written + alteration;
          if (voice.pending && !accidental && voice.pending.written === written) pitch = voice.pending.pitch;
          if (pitch < 0 || pitch > 127 || (voice.pending && voice.pending.pitch !== pitch)) invalid(`${label}: нарушена лига или диапазон MIDI`);
          const id = voice.pending?.id ?? nextId++;
          const event = { start: voice.time + offset, duration, pitch, id };
          notes.push(event); voice.notes.push(event);
          voice.pending = tie ? { pitch, written, id } : undefined;
          tokens.push({ raw: value, kind: "note", duration });
        }
        offset += duration;
      }
      if (offset !== barLength) invalid(`${label}: сумма длительностей ${offset} вместо ${barLength}`);
      const bar: Bar = { start: voice.time, length: barLength, notes, tokens };
      bars.push(bar); voice.bars.push(bar); voice.time += barLength;
    }
    if (bars.length < 1 || bars.length > 4) invalid(`${label}: ожидается 1–4 такта в группе`);
    return bars;
  }

  let cursor = 8;
  while (cursor < lines.length) {
    while (cursor < lines.length && (lines[cursor].startsWith("% ") || !lines[cursor].trim())) cursor++;
    if (cursor >= lines.length) break;
    if (lines[cursor++] !== "V: Vocal") invalid(`группа ${groups.length + 1}: ожидается V: Vocal`);
    const vocalMeter = /^M:/.test(lines[cursor] ?? "") ? lines[cursor++] : undefined;
    const vocalLine = cursor;
    const nextBarLength = vocalMeter ? meterLength(vocalMeter, unitDenominator) : barLength;
    barLength = nextBarLength;
    const vocalBars = parseLine(lines[cursor++] ?? "", vocal, "Vocal");
    if (lines[cursor++] !== "V: Ins") invalid(`группа ${groups.length + 1}: ожидается V: Ins`);
    const instrumentalMeter = /^M:/.test(lines[cursor] ?? "") ? lines[cursor++] : undefined;
    if (vocalMeter !== instrumentalMeter) invalid(`группа ${groups.length + 1}: размеры Vocal и Ins различаются`);
    const instrumentalLine = cursor;
    const instrumentalBars = parseLine(lines[cursor++] ?? "", instrumental, "Ins");
    if (vocalBars.length !== instrumentalBars.length) invalid(`группа ${groups.length + 1}: число тактов Vocal и Ins различается`);
    if (vocalMeter) meterChanges.push(`${groups.length + 1}:${vocalMeter}`);
    groups.push({ vocalLine, instrumentalLine, vocalBars, instrumentalBars });
  }
  if (!groups.length || vocal.time !== instrumental.time || vocal.pending || instrumental.pending) invalid("голоса не выровнены или лига не завершена");
  for (let i = 0; i < vocal.bars.length; i++) if (vocal.bars[i].start !== instrumental.bars[i].start || vocal.bars[i].length !== instrumental.bars[i].length) invalid(`такт ${i + 1}: сетки голосов не совпадают`);
  return { lines, trailingNewline, newline, groups, vocal, instrumental, unit: unitDenominator, bpm, meterChanges };
}

function subtract(note: Note, occupied: Note[]): Note[] {
  let pieces: Note[] = [{ ...note }];
  for (const block of occupied) {
    const left = block.start, right = block.start + block.duration;
    pieces = pieces.flatMap(piece => {
      const start = piece.start, end = start + piece.duration;
      if (right <= start || left >= end) return [piece];
      const kept: Note[] = [];
      if (start < left) kept.push({ ...piece, duration: left - start });
      if (right < end) kept.push({ ...piece, start: right, duration: end - right });
      return kept;
    });
  }
  return pieces;
}

function parts(duration: number): number[] {
  const result: number[] = [];
  while (duration > 0) {
    const next = durations.find(value => value <= duration);
    if (!next) invalid("нельзя записать длительность события");
    result.push(next); duration -= next;
  }
  return result;
}

function pitchToken(pitch: number): string {
  const pitchClass = pitch % 12;
  const names = ["C", "^C", "D", "^D", "E", "F", "^F", "G", "^G", "A", "^A", "B"];
  const name = names[pitchClass];
  const octave = Math.floor(pitch / 12);
  const base = name.startsWith("^") ? `^${name[1]}` : `=${name}`;
  if (octave >= 6) return base.toLowerCase().replace(/^\^/, "^").replace(/^=/, "=") + "'".repeat(octave - 6);
  return base + ",".repeat(5 - octave);
}

function encodeRest(duration: number): string { return parts(duration).map(part => `z${part === 1 ? "" : part}`).join(""); }

function encodeBar(bar: Bar, notes: Note[], allNotes: Note[]): string {
  const inside = notes.filter(note => note.start >= bar.start && note.start < bar.start + bar.length).sort((a, b) => a.start - b.start);
  if (!inside.length) return "Z";
  let cursor = bar.start, text = "";
  for (const note of inside) {
    if (note.start < cursor || note.start + note.duration > bar.start + bar.length) invalid("после переноса ноты пересекаются или выходят из такта");
    if (note.start > cursor) text += encodeRest(note.start - cursor);
    const next = allNotes.find(other => other.id === note.id && other.start === note.start + note.duration && other.pitch === note.pitch);
    const lengths = parts(note.duration), spelling = pitchToken(note.pitch);
    text += lengths.map((length, index) => `${spelling}${length === 1 ? "" : length}${index < lengths.length - 1 || next ? "-" : ""}`).join("");
    cursor = note.start + note.duration;
  }
  if (cursor < bar.start + bar.length) text += encodeRest(bar.start + bar.length - cursor);
  return text;
}

function compressRests(bars: string[]): string {
  let result = "";
  for (let i = 0; i < bars.length;) {
    if (bars[i] !== "Z") { result += `${bars[i++]}|`; continue; }
    let end = i + 1;
    while (end < bars.length && bars[end] === "Z" && end - i < 4) end++;
    result += `Z${end - i === 1 ? "" : end - i}|`;
    i = end;
  }
  return result;
}

function occupancy(notes: Note[]): string[] {
  const cells: string[] = [];
  for (const note of notes) for (let offset = 0; offset < note.duration; offset++) cells.push(`${note.start + offset}:${note.pitch}`);
  return cells.sort();
}

export function editYuE2VocalScore(text: string, mode: VocalEditMode) {
  if (!["instrumental_lead", "accompaniment_only"].includes(mode)) invalid("неизвестный режим редактирования вокала");
  const source = parseScore(text);
  const before = source.instrumental.notes;
  if (!source.vocal.notes.length) {
    if (!before.length) invalid("в ABC нет ни вокальной мелодии, ни инструментальной партии");
    return { abc: text, report: {
      mode, vocalNotesBefore: 0, vocalNotesAfter: 0,
      instrumentalNotesBefore: before.length, instrumentalNotesAfter: before.length,
      clippedInstrumentalNotes: 0, affectedInstrumentalNotes: [], bars: source.vocal.bars.length,
      nominalSeconds: Math.round(source.vocal.time * 4 / source.unit * 60 / source.bpm * 100) / 100,
      alreadyInstrumental: true, verified: true,
    } };
  }
  const after = mode === "instrumental_lead"
    ? [...source.vocal.notes, ...before.flatMap(note => subtract(note, source.vocal.notes))].sort((a, b) => a.start - b.start)
    : before;
  if (!after.length) invalid("после удаления вокала инструментальная партия пуста — минус не получится");
  const clipped = mode === "instrumental_lead" ? before.filter(note => {
    const kept = subtract(note, source.vocal.notes);
    return kept.length !== 1 || kept[0].start !== note.start || kept[0].duration !== note.duration;
  }).length : 0;
  const affectedInstrumentalNotes = mode === "instrumental_lead" ? before.flatMap(note => {
    const kept = subtract(note, source.vocal.notes);
    return kept.length === 1 && kept[0].start === note.start && kept[0].duration === note.duration ? [] : [{
      startUnits: note.start, pitchMidi: note.pitch, durationUnits: note.duration,
      retainedSegments: kept.map(part => ({ startUnits: part.start, durationUnits: part.duration })),
    }];
  }) : [];
  const lines = [...source.lines];
  for (const group of source.groups) {
    const oldVocal = lines[group.vocalLine];
    const stripped = oldVocal.slice(0, -1).split("|").map(bar => {
      const raw = bar.trim();
      if (/^Z[2-4]?$/.test(raw)) return raw;
      tokenPattern.lastIndex = 0;
      let cursor = 0, output = "";
      while (cursor < raw.length) {
        if (/\s/.test(raw[cursor])) { output += raw[cursor++]; continue; }
        tokenPattern.lastIndex = cursor;
        const match = tokenPattern.exec(raw);
        if (!match) invalid("не удалось убрать вокальную ноту");
        const token = match[0];
        output += token.startsWith('"') || token.startsWith("z") ? token : `z${notePattern.exec(token)?.[4] ?? ""}`;
        cursor = tokenPattern.lastIndex;
      }
      return output;
    });
    lines[group.vocalLine] = `${stripped.join("|")}|`;
    if (mode === "instrumental_lead") lines[group.instrumentalLine] = compressRests(group.instrumentalBars.map(bar => encodeBar(bar, after, after)));
  }
  const converted = lines.join(source.newline) + (source.trailingNewline ? source.newline : "");
  const checked = parseScore(converted);
  if (checked.vocal.notes.length || checked.vocal.time !== source.vocal.time || checked.instrumental.time !== source.instrumental.time || checked.bpm !== source.bpm || JSON.stringify(checked.meterChanges) !== JSON.stringify(source.meterChanges)) invalid("проверка преобразованного плана не прошла");
  if (JSON.stringify(occupancy(checked.instrumental.notes)) !== JSON.stringify(occupancy(after))) invalid("после преобразования изменились инструментальные ноты или ритм");
  if (mode === "accompaniment_only" && JSON.stringify(occupancy(checked.instrumental.notes)) !== JSON.stringify(occupancy(before))) invalid("режим минуса изменил сопровождение");
  const report = {
    mode,
    vocalNotesBefore: source.vocal.notes.length,
    vocalNotesAfter: 0,
    instrumentalNotesBefore: before.length,
    instrumentalNotesAfter: checked.instrumental.notes.length,
    clippedInstrumentalNotes: clipped,
    affectedInstrumentalNotes,
    bars: source.vocal.bars.length,
    nominalSeconds: Math.round(source.vocal.time * 4 / source.unit * 60 / source.bpm * 100) / 100,
    alreadyInstrumental: false,
    verified: true,
  };
  return { abc: converted, report };
}
