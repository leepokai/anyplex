// All configuration options: https://remotion.dev/docs/config
import { Config } from "@remotion/cli/config";

Config.setRspack(true);
// PNG frames: text stays crisp; JPEG capture softened the whole picture.
Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);
