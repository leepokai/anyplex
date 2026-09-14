// The launch video: one Sequence per storyboard scene, plus the brand anchor that persists
// through the showcase scenes. Timing lives in constants.ts (TIMELINE).
import type React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { BrandAnchor } from "./components/Glass";
import { COLOR, TIMELINE } from "./constants";
import { CapabilitiesScene } from "./scenes/CapabilitiesScene";
import { ClimaxScene } from "./scenes/ClimaxScene";
import { CloseScene } from "./scenes/CloseScene";
import { CodeScene } from "./scenes/CodeScene";
import { EventsScene } from "./scenes/EventsScene";
import { HookScene } from "./scenes/HookScene";
import { RevealScene } from "./scenes/RevealScene";

const SCENES: Record<keyof typeof TIMELINE, React.FC> = {
  hook: HookScene,
  reveal: RevealScene,
  code: CodeScene,
  events: EventsScene,
  capabilities: CapabilitiesScene,
  climax: ClimaxScene,
  close: CloseScene,
};

export const Launch: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: COLOR.background }}>
      {(Object.keys(TIMELINE) as (keyof typeof TIMELINE)[]).map((key) => {
        const { start, duration } = TIMELINE[key];
        const Scene = SCENES[key];
        return (
          <Sequence key={key} name={key} from={Math.round(start * fps)} durationInFrames={Math.round(duration * fps)} premountFor={fps}>
            <Scene />
          </Sequence>
        );
      })}
      <Sequence name="brand-anchor" from={Math.round(TIMELINE.code.start * fps)} durationInFrames={Math.round((TIMELINE.close.start - TIMELINE.code.start) * fps)}>
        <BrandAnchor delay={0.25} />
      </Sequence>
    </AbsoluteFill>
  );
};
