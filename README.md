<img src="docs/brand/icon.svg" width="64" height="64" alt="">

# Video Tool

Remove, swap and trim: quick treatments for a batch of videos. Windows, macOS and Linux.

Video Tool is not a video editor. Drop videos on it, pick the treatments, click Process: it applies
them to every video with ffmpeg, one video at a time, and writes the results as new files.

- Drop videos, many at once, or whole folders (their subfolders included) from Explorer, File
  Pilot, Finder or Nautilus; or choose them in a dialog. Files that are not videos are left out, and
  a video already in the list is not added twice (see [Adding videos](#adding-videos)).
- Treatments combine freely and run in a single ffmpeg pass per video: remove the audio, replace it
  with a soundtrack from the audio list, silence it at the start and the end, trim the start and
  the end.
- The audio list keeps the soundtracks you use from one session to the next, and plays them for a
  preview.
- Each video shows a still, what ffprobe found (duration, size, frame rate, codecs), and its
  progress and speed. Cancel one or all at any time, and run the failed or canceled ones again.
  Click a video's name to open it, or its folder to show it in Explorer, Finder or the file
  manager; once done, its result opens or shows the same way.
- **Originals are never modified or overwritten.** Each result is a new file whose name says what
  was done (see [Output files](#output-files)). A run that does not finish leaves no partial file
  behind.

Accepted videos, by extension: MP4, M4V, MOV, QT, MKV, WebM, AVI, WMV, FLV, MPG, MPEG, M2TS, MTS,
TS, 3GP and OGV. ffprobe then reads each one; a file it cannot read is marked unsupported and never
processed. A video whose stream records no duration (FLV, a browser's WebM recording, an
unfinished live capture) is read whole to find where it ends, for up to 2 minutes; past that, the
file's own duration is used, or the video is refused if it has none. Soundtracks: MP3, M4A, AAC, WAV, FLAC, OGG,
OGA, Opus, AIF, AIFF and WMA.

## Adding videos

Folders are walked depth-first, each one's videos before its subfolders, in the order file managers
show them ("clip 2" before "clip 10"). Hidden files and folders are skipped (names starting with a
dot, `$Recycle.Bin` and `System Volume Information`), and links to folders are not followed, so no
walk can loop; a video dropped on its own is added even if hidden. One drop takes up to 5,000 videos
from folders, all folders together, so that a drive dropped by mistake gives a long but workable
list. Past that, the status line says that the drop stopped there, and stays until the next
message. Dropping the same folder again would reach the same first 5,000: drop the rest separately,
by subfolder or as files.

Videos can also come from the system, without Video Tool ever becoming the default player:

- **macOS**: Finder's Open With lists it for every accepted video type and for folders, and videos
  or folders can be dropped on its Dock icon.
- **Linux**: the desktop entry lists the video MIME types, so file managers offer it under Open With
  for those videos (not for folders). No file type or icon of the system is changed.
- **Windows**: the installer registers no file types. Videos and folders dropped on the app or its
  shortcut are added, and Open with › Choose another app can point to it.

Files opened while Video Tool runs go to its window. Folders are walked as when dropped, but the
status line says nothing about what was opened this way, the 5,000 limit included.

## Treatments

**Audio**: keep it, remove it, or replace it with a soundtrack from the audio list. Keep keeps the
audio tracks (see [Output files](#output-files) for those ffmpeg cannot decode); a soundtrack
replaces them all, with its first audio stream. A soundtrack shorter than the video starts over as
many times as the video needs (Loop, on by default; any rounding at the very end is filled with
silence) or, with Loop off, silence fills the rest; a longer one is cut where the video ends. Either
way, the result lasts as long as the video. The soundtrack is encoded in AAC at 192 kb/s up to stereo and 384 kb/s above (in a WebM, Opus at 160 and 320 kb/s).

**Silence**: mute the audio, kept or new, for a length at the start of the result, at its end, or
both, each in seconds or in frames (counted as they show, as for trims). The video plays on.

- Lengths count on the result, once trimmed: from its first frame (for a fast cut, the keyframe it
  starts at) and back from the end of its last one. Any audio before the first frame, or after the
  last, is silent too.
- The cut to silence is hard: the lengths silenced are silent throughout. The sound next to them
  fades in or out over 5 ms, so that it does not click.
- Silencing encodes the audio again (AAC, or Opus in a WebM, at the rates above), never the video:
  on its own, it takes about as long as a copy. Audio tracks that ffmpeg cannot decode cannot be
  silenced, and are left out (see [Output files](#output-files)).
- Silences that would leave no sound are refused: remove the audio instead. A video without audio
  has nothing to silence: it is refused, unless it is trimmed too. Silences do not apply when the
  audio is removed.

**Trim**: remove a length at the start, at the end, or both, each in seconds or in frames.

- Seconds can be typed as `2`, `2.5` (or `2,5`), `1:02.5` (minutes and seconds) or `1:02:03.25`
  (hours, minutes and seconds). They are rounded up to a whole frame at the video's average frame
  rate, so a cut never splits a frame: removing 0.5 s at 30 fps removes frames 0 to 14. On a video
  whose frame rate varies, they remove what shows in that time, however many frames that is.
- Frames are a whole number, counted as they show: when each frame shows is read from the file's
  packets, without decoding. Counts are exact on variable-frame-rate videos too (phone clips, screen
  and game recordings), and frames that an edit list hides (in an MP4 or MOV cut without
  re-encoding) do not count. AVI with B-frames stores no such times: there the frame rate is used,
  constant in AVI. Trimming or silencing the end in frames reads the whole video once before
  processing, and so does silencing the start in frames after a start trim in seconds; trimming or
  silencing the start in frames reads only its beginning: large files on slow drives take a
  moment.
- A video whose frame rate ffprobe cannot tell can only be trimmed in seconds, and so can the end of
  one whose frames cannot be counted. A video that the trims would remove entirely is not
  processed, and the app says why.

**Precision**, for trims:

- **Exact** (the default) cuts on the very frame asked for. It re-encodes the video and the audio
  tracks it keeps: it takes far longer than a copy, the file size changes, and each re-encoding
  loses a little detail; even a lossless audio track (FLAC, PCM) becomes lossy. See
  [Exact cuts](#exact-cuts) for the encoders.
- **Fast** copies the video, and the audio it keeps, untouched: about as quick as copying the file,
  and no loss at all. But a cut at the start moves back to the keyframe before it, so the result
  may begin a little earlier than asked, up to a few seconds depending on how often the video has
  keyframes. A cut at the end follows the order frames are stored in, and may keep a few frames
  more than asked, which a new soundtrack leaves silent. Apart from those, a new soundtrack starts
  with the first frame and ends with the last, within one audio frame (about 20 ms); after a cut at
  the start of an MPEG stream (TS, M2TS, MTS, MPG), it may start slightly before the first frame.

Removing, replacing or silencing the audio alone never re-encodes the video, whatever the precision:
its stream is copied as it is. Copies of DivX and Xvid videos unpack their "packed B-frames" into standard
MPEG-4, without re-encoding.

### Exact cuts

The video keeps its codec when the result's format takes it, with the first encoder this ffmpeg
has:

- **H.264**, and codecs without a family of their own (MPEG-2, MPEG-4, ProRes, DNxHD, MJPEG…):
  H.264 with libx264 at CRF 18 (preset medium). Builds without libx264 (LGPL builds) use the
  system's encoder instead (VideoToolbox on macOS, Media Foundation on Windows), or OpenH264, at the
  source's bit rate (8 Mb/s when it is unknown).
- **HEVC**: HEVC with libx265 at CRF 20 (preset medium), tagged `hvc1` outside MKV for Apple's
  players; else H.264.
- **VP8, VP9**: VP9 with libvpx-vp9 at CRF 30; else AV1, else H.264.
- **AV1**: AV1 with SVT-AV1 (CRF 30, preset 8) or libaom (CRF 30); else VP9, else H.264.

WebM results take only VP9 or AV1, and MOV results only H.264 or HEVC: a ProRes MOV gives an H.264
MOV. When this ffmpeg has none of the encoders a video needs, that video fails and says so: fast
cuts, or a complete ffmpeg build, avoid it.

- Frames keep their timestamps: a variable frame rate stays variable, and no frame is dropped or
  duplicated. The audio, kept or new, is cut where the video is, in frames too.
- H.264 made from another codec (ProRes, DNxHD, camera MJPEG, QuickTime Animation…) is 8-bit
  4:2:0, High profile with libx264, which the system players play; full-range video stays
  full-range, whatever the ffmpeg version. An H.264 source re-encoded with libx264 keeps its chroma
  and bit depth, and HEVC stays HEVC, 10-bit included. The system encoders and OpenH264 always make
  8-bit 4:2:0.
- Interlaced video (AVCHD camcorder footage, broadcast TS, interlaced DV, ProRes or MPEG-2) stays
  interlaced with libx264, in its field order. The other encoders deinterlace it, one frame per
  frame, so that cuts and frame counts stay the same. Fast cuts copy it as it is.
- Kept audio is encoded in AAC at 192 kb/s up to stereo and 384 kb/s above; in a WebM, in Opus at
  160 and 320 kb/s (Vorbis without libopus).

## Output files

Results are written next to each source (the default) or all in a folder you choose. They keep the
source's format when it is MP4, M4V, MOV, MKV or WebM (a `.qt` file gives a `.mov`). Other formats
(AVI, WMV, FLV, MPG, MPEG, M2TS, MTS, TS, 3GP, OGV) become MP4 when an exact cut re-encodes the
video, and MKV otherwise, which takes whatever codec they hold. Names say what was done:

| Treatments                                     | Result for `Holiday.mov`             |
| ---------------------------------------------- | ------------------------------------ |
| Remove the audio                               | `Holiday (no audio).mov`             |
| Replace the audio with `Beach waves.mp3`       | `Holiday (Beach waves).mov`          |
| Trim                                           | `Holiday (trimmed).mov`              |
| Remove the audio and trim                      | `Holiday (no audio, trimmed).mov`    |
| Silence the start or the end                   | `Holiday (muted).mov`                |
| Trim and silence                               | `Holiday (trimmed, muted).mov`       |
| Replace the audio with `Beach waves.mp3`, trim | `Holiday (Beach waves, trimmed).mov` |

A replaced audio is named by the suffix of its soundtrack: the soundtrack's file name without its
extension, unless another is typed under it in the audio list. Each soundtrack keeps its own. What
file names cannot hold on Windows, macOS or Linux (`< > : " / \ | ? *` and control characters)
becomes a space, direction marks are left out, and a suffix keeps at most 120 bytes: 120 letters
without accents, 60 accented, Greek or Cyrillic ones, 40 Chinese or Japanese characters. Leaving the
field empty brings back the file name.

When that name is taken, a number follows: `Holiday (no audio) 2.mov`, then 3, and so on. An
existing file is never overwritten. A name too long for the file system is shortened.

A result holds the video stream (the first one that is not cover art), the audio tracks unless they
are removed or replaced, and the source's metadata and chapters. Subtitles are kept when the result
has the source's format and can hold them as they are: SubRip, ASS/SSA, WebVTT, PGS, DVD and DVB in
MKV, with the fonts attached for them; mov_text and DVD in MP4 and M4V; mov_text in MOV; WebVTT in
WebM. Other video streams, cover art, data and timecode tracks, and other attachments are left out.
Audio tracks that ffmpeg cannot decode, such as the spatial audio (APAC) of recent iPhones, are
copied as they are into MOV results, so an iPhone `.MOV` keeps them. MP4, MKV and WebM cannot hold
them: those results leave them out, keep the other tracks, and the log says so. Silencing leaves them
out of every result, MOV included, since they cannot be silenced; a video whose audio is all of that
kind cannot be silenced.

ffmpeg writes to a partial file in the destination folder, `.<name>.partial-<id>.<ext>` (hidden on
macOS and Linux), which gets its final name only once complete. It is deleted when the video fails,
is canceled or removed from the list, and when the app quits. Canceling or quitting stops ffmpeg, on
Windows with its whole process tree, so that a launcher (a Chocolatey shim) cannot leave it running.
Quitting while videos are queued or processing asks first; on macOS, closing the window does not
quit, and processing goes on. When Windows shuts down, restarts or signs out during processing, it
lists Video Tool among the apps keeping it from ending, where you can cancel; if it ends anyway,
ffmpeg is stopped, its partial file deleted and the settings saved before the app exits. A crash or
a power cut can still leave a partial file behind; it can be deleted.

## Requirements

- Node.js 24 (see `.nvmrc`) and pnpm 12, for development. The exact pnpm version is pinned in
  `package.json` (`packageManager`); pnpm switches to it by itself.
- `ffmpeg` and `ffprobe`, version 4.4 or later: Video Tool cannot process anything without them,
  and says so when it cannot find them or when they are too old. It looks for them, in order:
  1. in the folder named by `VIDEO_TOOL_FFMPEG_DIR`, when it is set;
  2. in the packaged app's own `resources/bin/` (see [resources/bin](resources/bin/README.md));
  3. on the `PATH`, which is what development uses;
  4. on macOS and Linux, in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and `/snap/bin`,
     since an app opened from the Finder or a desktop launcher does not get the shell's `PATH`.

  To install them: `brew install ffmpeg` on macOS (with [Homebrew](https://brew.sh)),
  `winget install Gyan.FFmpeg` on Windows (then restart Video Tool if it was open),
  `sudo apt install ffmpeg` on Debian 12 and Ubuntu 22.04 or later.

  Video Tool is tested with ffmpeg 4.4, 5.1, 6.0, 6.1, 7.1 and 9.0, which covers what Ubuntu 22.04
  (4.4), Debian 12 (5.1), Ubuntu 24.04 (6.1) and Debian 13 (7.1) ship. Some options it needs were
  renamed over these versions: it tries them once, at startup, and uses the names this ffmpeg
  knows. An ffmpeg that knows no name for one of them (older than 3.4) is refused. The window then
  says "ffmpeg 4.4 or later is needed; this one is 3.2.18. Update it, then restart Video Tool",
  with the command for it on macOS (`brew upgrade ffmpeg`) and Windows
  (`winget install Gyan.FFmpeg`), and Process stays unavailable: "Update ffmpeg to process videos."
  Videos are still read, and show their still and details. The version shown is the release
  (`3.2.18` for `3.2.18-0+deb9u1`); a build from git shows its whole name. Versions 3.4 to 4.3 are
  not refused, but untested.

Release installers do not include ffmpeg. Bundling it in a public release brings license
obligations: an LGPL build must come with its license text and a pointer to its source, and a GPL
build (any with libx264 or libx265, as most ready-made builds are) must meet the GPL, which asks
more.

## Development

With Node.js 24, pnpm 12 and ffmpeg installed (see [Requirements](#requirements)), from a clone:

```sh
pnpm install   # dependencies, and the git hooks
pnpm dev       # the app, with live reload
```

`pnpm dev` starts the Angular dev server and Electron. Edits to the interface (`src/renderer`)
show at once in the window; edits to the Electron side (`src/main`, `src/preload`) rebuild it and
restart the app. It takes `ffmpeg` and `ffprobe` from the `PATH`.

To build the app for the system you are on:

```sh
pnpm package       # installers, in release/
pnpm package:dir   # only the app, unpacked: quicker, to try a build
```

Both build for the operating system and processor they run on, and only those: a Mac build is
made on a Mac. CI makes the builds for all three systems (see [Releasing](#releasing)).

| System  | `pnpm package`                                                      | `pnpm package:dir`                                           |
| ------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Windows | `video-tool-<version>-win-x64-setup.exe`                            | `release/win-unpacked/Video Tool.exe`                        |
| macOS   | `video-tool-<version>-mac-arm64.dmg` (`-x64` on Intel)              | `release/mac-arm64/Video Tool.app` (`release/mac/` on Intel) |
| Linux   | `video-tool-<version>-linux-x86_64.AppImage` and `-linux-amd64.deb` | `release/linux-unpacked/video-tool`                          |

Builds are not code-signed. On macOS, electron-builder still signs with a developer certificate it
finds in the Keychain; `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package` stops it, as CI does.
ffmpeg is not included, unless placed in `resources/bin/<mac|win|linux>/` before building (see
[resources/bin](resources/bin/README.md)).

## Scripts

| Command                                | What it does                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm dev`                             | Angular dev server + Electron: UI edits reload live, Electron-side edits restart the app |
| `pnpm start`                           | Production build, then run it **with your real settings and audio list**                 |
| `pnpm build`                           | Renderer (Angular CLI) and Electron side (esbuild) into `dist/`                          |
| `pnpm package[:dir]`                   | Installers (or an unpacked app) in `release/`                                            |
| `pnpm icons`                           | Draws the app icon into `build/`, `docs/brand/` and `assets/` (`scripts/build-icons.ts`) |
| `pnpm test`                            | Renderer tests (`ng test`, Vitest) and Electron-side tests (Vitest)                      |
| `pnpm test:renderer` / `test:electron` | One half of `pnpm test`                                                                  |
| `pnpm lint` / `typecheck`              | ESLint (type-aware, every layer) / every TypeScript project                              |
| `pnpm lint:fix`                        | ESLint, applying its automatic fixes                                                     |
| `pnpm format` / `format:check`         | Prettier: rewrite files / only report them, as CI does                                   |

`pnpm dev` keeps its own data folder in `.dev-data/` and serves the UI on port 4318; quitting the
app, or Ctrl-C in the terminal, ends the session. `pnpm start` uses the installed app's data folder.

| Environment variable            | Effect                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `VIDEO_TOOL_USER_DATA`          | Another data folder, for either command: `VIDEO_TOOL_USER_DATA=.dev-data pnpm start` |
| `VIDEO_TOOL_DEV_PORT`           | The port of `pnpm dev` (4318 by default)                                             |
| `VIDEO_TOOL_FFMPEG_DIR`         | A folder holding the `ffmpeg` and `ffprobe` to use, before any other                 |
| `VIDEO_TOOL_REQUIRE_FFMPEG`     | `1`: the ffmpeg integration tests fail without ffmpeg, instead of being skipped      |
| `VIDEO_TOOL_FIXTURE_FFMPEG_DIR` | Tests only: another ffmpeg folder, to make the test clips and measure the results    |

Electron-side tests run on plain Node: the app has no native addons. The ffmpeg integration tests
run the `ffmpeg` and `ffprobe` that the app would find (`VIDEO_TOOL_FFMPEG_DIR` first, then the
`PATH`), which also make the clips and measure the results. CI installs them on each OS (on Windows
with Chocolatey, whose real binaries go on the `PATH` ahead of its shims) and sets
`VIDEO_TOOL_REQUIRE_FFMPEG=1`. To test an older ffmpeg on clips that a current one makes and
measures:

```sh
VIDEO_TOOL_FFMPEG_DIR=<old bin> VIDEO_TOOL_FIXTURE_FFMPEG_DIR=<current bin> \
  VIDEO_TOOL_REQUIRE_FFMPEG=1 pnpm exec vitest run src/main
```

With ffmpeg 4.4 alone, two tests fail because of 4.4 itself: it moves the first frame of an MP4
remuxed to MKV, and its ffprobe reads no field order from H.264.

## Architecture

```
Renderer (Angular 22)  ──window.videoTool──▶  Main process (Electron)
  drop zone, lists,        (preload, IPC)       video list and queue, audio list,
  treatments          ◀──── list changes ────   settings.json, dialogs, shell
        ▲                                         │                  │ child processes,
        └──────── app://, thumb://, track:// ─────┘                  ▼ one video at a time
                                                               ffprobe, ffmpeg
```

- **Main** (`src/main`): owns the video list, the queue, the audio list and the settings. It reads
  each file with `ffprobe` (four at a time), turns the treatments into one `ffmpeg` command per
  video, runs them as child processes one at a time, below normal priority, while following their
  progress, and deletes the partial file of a run that does not finish. What the user does reaches
  the renderer at once; what happens on its own (probe results, progress, videos finishing) at most
  five times a second, so that a drop of thousands of videos does not flood it. It serves the
  renderer over `app://`, video stills over `thumb://` and soundtracks, for previews, over
  `track://`.
- **Preload** (`src/preload`): exposes the typed bridge as `window.videoTool`, and nothing else; the
  renderer is sandboxed, without Node.js.
- **Renderer** (`src/renderer`): standalone components, signals, zoneless, OnPush (the v22
  default). It shows the lists and the treatments and asks the main process for every change; the
  main process sends the lists back as they change.
- **Shared contracts** (`src/shared`): the domain model, the bridge and its IPC channels, and the
  rules of the treatments, which both sides apply: the renderer warns before a run, the main
  process refuses the same cases. ESLint enforces that layers only meet there; the renderer and the
  shared code cannot import Node built-ins or Electron.

There are no runtime npm dependencies: ffmpeg and ffprobe are separate programs, found as described
in [Requirements](#requirements).

## Settings and audio list

The settings (the treatments last chosen, where results go) and the audio list are saved in
`settings.json` in the data folder: `%APPDATA%\Video Tool` on Windows,
`~/Library/Application Support/Video Tool` on macOS, `~/.config/Video Tool` on Linux, unless
`VIDEO_TOOL_USER_DATA` names another.

- Changes are saved as they are made. Each save replaces the file whole, so a crash never leaves
  half of it. A value it does not recognise takes its default.
- A `settings.json` that cannot be read (held by another program, or without permission) is tried
  again for about 0.4 s, then renamed `settings.json.unreadable-<date>`. One that is not valid JSON,
  or of another format version, is renamed `settings.json.corrupt-<date>`. The date is UTC, as in
  `settings.json.corrupt-2026-10-25T12-04-59-123Z`, and the copy stays in the data folder. Either
  way, the app starts over with the default settings and an empty audio list.
- If that file cannot even be renamed, the app never writes over it: changes apply but are not
  saved, and each one tries the rename again; saving resumes once it works. Only the log says so
  (the main process's console): the window shows nothing.
- The audio list holds paths: soundtracks stay where they are, and are only read. One whose file was
  moved or deleted stays listed as missing, and comes back when the file does. Removing it from the
  list leaves the file alone.
- Each soundtrack is saved with its suffix (see [Output files](#output-files)), next to its path. A
  soundtrack saved without one, by an earlier version, takes its file name.

## Releasing

Versions follow calendar versioning, `YYYY.M.PATCH` (no zero-padding, PATCH restarts at 0 each
month), with `-alpha.N` / `-beta.N` suffixes before a stable release.

1. Set `version` in `package.json`, commit it as `chore(release): <version>`.
2. Tag that commit `v<version>` (annotated) and push the branch and the tag.
3. The **Release** workflow checks the tag against `package.json`, runs CI, builds the installers
   on macOS, Windows and Linux, and attaches them to a **draft** GitHub release (marked as a
   pre-release for `-alpha`/`-beta` versions).
4. Review the draft and its notes on GitHub, then publish it.

To try packaging without releasing, run the **Release** workflow manually on a branch
(`gh workflow run release.yml --ref master`): the installers are kept as workflow artifacts for a
week.

## Conventions

Conventional Commits, enforced by commitlint. Git hooks are managed by lefthook and installed by
`pnpm install`: ESLint and Prettier on staged files before each commit, and type checks plus tests
before each push.

CI runs on every push to `master` and on pull requests: workflow lint (actionlint), format, lint
and type checks, then tests (with ffmpeg installed) and a build on Linux, macOS and Windows.

## License

[MIT](LICENSE).
