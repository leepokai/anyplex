// The launch video: one Sequence per storyboard scene, plus the brand anchor that persists
// through the showcase scenes. Timing lives in constants.ts (TIMELINE).
import { Audio } from "@remotion/media";
import type React from "react";
import { AbsoluteFill, interpolate, Sequence, staticFile, useVideoConfig } from "remotion";
import { BrandAnchor } from "./components/Glass";
import { COLOR, DURATION_SEC, TIMELINE } from "./constants";
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
      {/* Music bed synthesized by scripts/music.py: fades in over a second, sits under the
          climax's terminal, and fades out over the close. */}
      <Audio
        name="music"
        src={staticFile("music.m4a")}
        volume={(f) =>
          interpolate(
            f,
            [0, 1 * fps, TIMELINE.climax.start * fps, (TIMELINE.climax.start + 0.5) * fps, TIMELINE.close.start * fps, DURATION_SEC * fps],
            [0, 0.85, 0.85, 0.7, 0.8, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )
        }
      />
    </AbsoluteFill>
  );
};
