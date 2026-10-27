# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The author, first: Video Tool is a personal tool for the treatments they keep applying to their own
videos, in batches: removing or replacing the soundtrack, silencing it or trimming a few seconds or
frames at the start or the end. It is free and open source (MIT), so other people may use it later; no outside
users exist yet.

## Product Purpose

Apply a few predefined treatments to many videos at once, without opening a video editor. Video
Tool takes the videos dropped on it, applies the chosen treatments to each one with ffmpeg in a
single pass, and writes the results as new files.

Success: going from a folder of clips to treated copies takes a drop, a few clicks and the encoding
time; the user never types an ffmpeg command, and never wonders whether an original was touched.

## Positioning

Four commitments define Video Tool, and future work must not trade any of them away:

- **Originals are never modified.** Sources are only read. Each output is a new file whose name
  says what was done, numbered rather than overwriting anything, the source included; a run that
  does not finish (canceled, failed, quit, or ended with the Windows session) deletes its partial
  file.
- **Treatments, not editing.** A small set of predefined treatments (keep, remove or replace the
  audio; silence its start and its end; trim the start and the end; exact or fast cuts), chosen
  once, or from a preset, and applied to the whole batch. Guardrail: **Video Tool is not a video editor.** No timeline, no scrubbing, no per-video
  edits; a feature that needs them belongs in another app.
- **Batch first.** Many videos and whole folders at once, one ffmpeg pass per video, one video at a
  time, with progress, cancel and retry.
- **Plain about trade-offs.** Exact or fast cuts, what re-encoding costs, why a video cannot be
  processed: said in plain words, before the run whenever it can be known.

## Operating Context

- Desktop app (Electron) for Windows 10 and 11, macOS, and Linux (Debian, Ubuntu). The interface is
  rendered as a web page, with desktop conventions: macOS inset title bar, platform names for "Show
  in Finder" / "Show in Explorer", the system light or dark appearance.
- Videos arrive by drag and drop from the system's file manager (Explorer, File Pilot, Finder,
  Nautilus), folders included, or from an open dialog. They may sit on any drive, under any path:
  drive letters, spaces, non-ASCII names.
- They also arrive from the system, without the app ever becoming the default player: Finder's
  Open With and the Dock icon on macOS (videos and folders), the desktop entry's video MIME types
  on Linux, drops on the app or its shortcut on Windows, whose installer registers no file types.
- ffmpeg and ffprobe (4.4 or later, as Ubuntu 22.04 ships them; tested up to 9.0) are separate
  programs, and required. The app looks for them in `VIDEO_TOOL_FFMPEG_DIR`, in its bundled
  `resources/bin/`, on the `PATH`, then in the usual install folders (an app opened from the Finder
  or a launcher lacks the shell's `PATH`), and says plainly when it cannot find them. It uses the
  option names each version has; one too old to have them (before 3.4) is refused, with the command
  that updates it where there is one. Installers do not bundle them yet: users install ffmpeg
  themselves.
- The data folder holds `settings.json`: the settings, the audio list and the presets. A file that cannot be
  read or understood is renamed `settings.json.unreadable-<date>` or `settings.json.corrupt-<date>`
  and the app starts with the defaults: never silently lost, and never written over while it
  cannot be renamed.
- Status: alpha (2026.10.0-alpha.1), not released yet; installers come from the GitHub Release
  workflow.

## Capabilities and Constraints

- Video list: videos are added by extension (MP4, MOV, MKV, WebM, AVI and 11 more); folders add the
  videos below them, hidden ones aside, up to 5,000 per drop (the status line says when a drop in
  the window stopped there); videos already listed are skipped, and other files ignored, with
  counts. Each video shows a still, what ffprobe found (duration, frame rate, codecs…), and where it
  stands: probing, ready, unsupported, queued, running (progress, speed), done, failed (with the
  reason) or canceled. Its source opens in its default app or shows in the file manager, in every
  state; once done, so does its output.
- Audio: keep it, remove it, or replace it with a soundtrack from the audio list. A shorter
  soundtrack starts over (Loop, on by default) or silence fills the rest; a longer one is cut where
  the video ends.
- Silence: mute the audio, kept or new, at the start and the end of the result, once trimmed, in
  seconds or in whole frames as for trims. A hard cut, the sound next to it fading over 5 ms against
  clicks. It encodes the audio again, never the video. Silences that would leave no sound are
  refused; audio that ffmpeg cannot decode cannot be silenced, and is left out.
- Presets: treatments saved under a name and kept across restarts, each setting the sections
  ticked when saving it (audio, silence, trim, output) and leaving the others. Each is a button:
  applying one takes a click. The one applied last stays current, says when the treatments changed
  from it, and can be updated or applied again, renamed or deleted. Names are unique, whatever the
  case; results are not named after presets.
- Audio list: kept across restarts. Soundtracks are added as files (no folders) and probed for
  their duration; one whose file is missing or unreadable is marked so, and comes back when the
  file does. Removing one never touches the file.
- Trim: at the start and the end, in seconds (`2.5`, `1:02.5`, `1:02:03.25`) or in whole frames,
  which needs a known frame rate. Frames count as they show, read from the file's packets, so frame
  trims are exact on variable-frame-rate videos too. Trims that would remove a whole video are
  refused for that video.
- Precision: _exact_ (the default) re-encodes the video so cuts land on the frame, in its own codec
  where the output format takes it (H.264 with libx264 at CRF 18, or the platform's encoder or
  OpenH264 with LGPL builds of ffmpeg; HEVC with libx265 at CRF 20; VP9 and AV1 at CRF 30), and
  re-encodes the audio it keeps (AAC, Opus in WebM); _fast_ copies the streams, and a cut at the
  start moves back to the keyframe before it. Removing, replacing or silencing the audio alone
  never re-encodes the video.
- Output: next to each source (the default) or in a chosen output folder. The format of the source
  is kept for MP4, M4V, MOV, MKV and WebM (QT gives MOV); others become MP4 when re-encoded, MKV
  when copied. Names say what was done: `<name> (no audio).<ext>`, `<name> (<suffix>).<ext>`,
  `<name> (trimmed).<ext>`, `<name> (muted).<ext>`, combined as `<name> (no audio, trimmed).<ext>`
  or `<name> (<suffix>, trimmed, muted).<ext>`; the `<suffix>` of a
  replaced audio is the soundtrack's, its file name without the extension unless the user typed
  another in the audio list. When taken, `<name> (no audio) 2.<ext>`, 3, and so on. Metadata and
  chapters are kept, and subtitles when the result keeps the source's format and can hold them as
  they are.
- Processing: one ffmpeg process at a time, every treatment in one pass. Videos can be canceled one
  by one or all at once, and failed or canceled ones run again. A treatment that cannot apply to a
  video fails that video, saying why, without stopping the others. Quitting during a run asks
  first; a Windows shutdown, restart or sign-out during one is held off (the user can cancel it),
  and if it goes ahead, ffmpeg is stopped and its partial file deleted before the app exits.
- Terminology: _video list_, _audio list_, _soundtrack_, _treatments_, _preset_, _trim_, _silence_,
  _exact_ and _fast_ cuts, _source_ (the original video), _output_ (the new file), _output folder_, _data folder_.
- Architecture: the main process owns the lists, the settings and the ffmpeg processes; the
  renderer only shows them and asks for changes. No runtime npm dependencies and no native addons.
- License: MIT, for the app's own code. If installers ever bundle `ffmpeg`/`ffprobe`, releases must
  honour ffmpeg's license: an LGPL build comes with its license text and a pointer to its source; a
  GPL build (any with libx264 or libx265) must meet the GPL, which asks more.

## Brand Commitments

- Name: **Video Tool**. Tagline: "Remove, swap and trim: quick treatments for a batch of videos."
- App icon: a frame of film between two columns of perforations, the author's SG logo on it. Lime
  (`#a8c70b`, the logo's own colour) on olive black (`#131510`, the ground of SG Tag, the author's
  other app); the logo is drawn in the ground's colour on the lime frame. No text, since font
  rendering varies. `scripts/build-icons.ts` draws it (on Apple's grid with a drop shadow for
  macOS, nearly full bleed for Windows and Linux, snapped to the pixel grid at 16 and 32 px) and
  writes the installer icons, `docs/brand/icon.svg` and `assets/icon.svg` (`pnpm icons`).
- No wordmark or lockups yet.

## Evidence on Hand

- The working app and its README; no screenshots, users, testimonials or reviews yet.
- No measurements of encoding speed, of exact against fast cuts, or of output quality: do not quote
  figures that have not been measured. CRF values (18, 20, 30) are settings, not quality
  measurements.

## Product Principles

1. **The originals are the user's.** Read them, never write them, and never overwrite any file.
   When something cannot be done, leave the disk as it was.
2. **A batch, not a project.** Treatments are chosen once and applied to everything in the list; no
   per-video editing creeps in.
3. **One pass, predictable results.** Every treatment in one ffmpeg run per video, an output name
   that says what was done, the same result for the same treatments.
4. **Say what it costs, in plain words.** Exact or fast, re-encoding, a missing or outdated ffmpeg,
   a video that cannot be trimmed: explain before the run where possible, and say why when a video
   fails.
5. **Built for one, careful for all.** Decisions serve the author's own videos first, while working
   on every platform and with any file name.
