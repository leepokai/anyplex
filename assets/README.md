The mark is a router: four strands (the hosted agent runtimes) converge into one hub node and leave as a single line (one session interface, one event stream). `icon.svg` is for light backgrounds, `icon-dark.svg` for dark ones; the PNGs are rendered from `icon.svg` with a transparent background.

Embed it in the project README with `<img src="assets/icon.svg" width="96">`.

`launch.gif` / `launch.mp4` are the launch recording: `assets/demo.sh` types and runs
`examples/switch.ts` on two vendors live (about two cents). Re-record with
`asciinema rec -c "zsh assets/demo.sh" --cols 100 --rows 22 --overwrite assets/launch.cast`,
then `agg --font-size 18 --theme monokai assets/launch.cast assets/launch.gif` and
`ffmpeg -i assets/launch.gif -movflags faststart -pix_fmt yuv420p assets/launch.mp4`.
