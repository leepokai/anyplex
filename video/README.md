# anyplex launch video

A 40-second product launch video built with [Remotion](https://remotion.dev), following the
`product-launch-video` skill: `storyboard.json` is the storyboard, `src/constants.ts` holds the
palette, fonts, and scene timeline, `src/scenes/*` is one file per scene, and
`src/utils/animations.ts` the motion primitives (springs and Bézier curves only, no CSS
transitions). `public/terminal.mp4` is the real recording (`assets/launch.cast` rendered by agg
at a large font so the inset is downscaled, never upscaled), and `public/music.m4a` is the
music bed synthesized by `scripts/music.py` (numpy + scipy; license-free by construction).

```sh
cd video && npm install
npx remotion studio                                   # preview and scrub
npx remotion still Launch out/frame.png --frame=450   # one frame
npx remotion render Launch out/anyplex-launch.mp4 --codec h264 --crf 18
```

Renders land in `out/` (ignored). Change colors in `constants.ts`, timing in `TIMELINE`,
copy in the scene files, the music in `scripts/music.py` (then `python3 scripts/music.py`
and re-encode with `ffmpeg -i public/music.wav -codec:a aac -b:a 192k public/music.m4a`).
Frames are captured as PNG (`remotion.config.ts`); JPEG capture visibly softens text.
