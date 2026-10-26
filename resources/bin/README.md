Put platform-specific `ffmpeg` and `ffprobe` executables in `mac/`, `win/` or `linux/`
(`ffmpeg.exe` and `ffprobe.exe` on Windows; executable on macOS and Linux), version 4.4 or later.
They are bundled into the packaged app as `resources/bin/` and preferred over the ones installed on
the system; only `VIDEO_TOOL_FFMPEG_DIR` comes first. Video Tool cannot process anything without
ffmpeg, so a build without them relies on the user installing it. In development, the ffmpeg on the
PATH is used.

Pick LGPL builds if the app is ever distributed with them, and ship their license text and a pointer
to their source. LGPL builds lack `libx264` and `libx265`: exact cuts of H.264, HEVC and most other
videos then re-encode to H.264 with the system's encoder (`h264_videotoolbox` on macOS, `h264_mf` on
Windows) or `libopenh264`, at the source's bit rate, so check that the build includes one of them
(on Linux, only `libopenh264` can). VP8, VP9 and AV1 videos stay in their family with `libvpx-vp9`,
`libsvtav1` or `libaom-av1`. Exact cuts of a WebM need one of these, and `libopus` or `libvorbis`
for its audio, as a new soundtrack in a WebM does.
