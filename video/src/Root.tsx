import "./index.css";
import type React from "react";
import { Composition, Folder } from "remotion";
import { DURATION_SEC, FPS, HEIGHT, TIMELINE, WIDTH } from "./constants";
import { Launch } from "./Launch";
import { CapabilitiesScene } from "./scenes/CapabilitiesScene";
import { ClimaxScene } from "./scenes/ClimaxScene";
import { CloseScene } from "./scenes/CloseScene";
import { CodeScene } from "./scenes/CodeScene";
import { EventsScene } from "./scenes/EventsScene";
import { HookScene } from "./scenes/HookScene";
import { RevealScene } from "./scenes/RevealScene";

const scene = (id: keyof typeof TIMELINE, component: React.FC) => (
  <Composition
    key={id}
    id={`Scene-${id}`}
    component={component}
    durationInFrames={Math.round(TIMELINE[id].duration * FPS)}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
);

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Launch" component={Launch} durationInFrames={DURATION_SEC * FPS} fps={FPS} width={WIDTH} height={HEIGHT} />
    <Folder name="Launch-Scenes">
      {scene("hook", HookScene)}
      {scene("reveal", RevealScene)}
      {scene("code", CodeScene)}
      {scene("events", EventsScene)}
      {scene("capabilities", CapabilitiesScene)}
      {scene("climax", ClimaxScene)}
      {scene("close", CloseScene)}
    </Folder>
  </>
);
