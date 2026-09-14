# anyplex launch video

A 40-second product launch video built with [Remotion](https://remotion.dev), following the
`product-launch-video` skill: `storyboard.json` is the storyboard, `src/constants.ts` holds the
palette, fonts, and scene timeline, `src/scenes/*` is one file per scene, and
`src/utils/animations.ts` the motion primitives (springs and Bézier curves only, no CSS
transitions). `public/terminal.mp4` is the real recording from `assets/launch.mp4`.

```sh
cd video && npm install
npx remotion studio                                   # preview and scrub
npx remotion still Launch out/frame.png --frame=450   # one frame
npx remotion render Launch out/anyplex-launch.mp4 --codec h264 --crf 18
```

Renders land in `out/` (ignored). Change colors in `constants.ts`, timing in `TIMELINE`,
copy in the scene files.
