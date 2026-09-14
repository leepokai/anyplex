// Climax (30.3–36.3 s): the real terminal recording, framed.
import { Video } from "@remotion/media";
import type React from "react";
import { AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop, Glow } from "../components/Backdrop";
import { Caption, LightSweep } from "../components/Glass";
import { COLOR, FONT, TIMELINE } from "../constants";
import { EASE_DRAMA, EASE_DRIFT, EASE_GLIDE, HEAVY, pop, ramp } from "../utils/animations";

const FRAME = { x: 410, y: 200, w: 1100, h: 800 };
const TRIM_SEC = 16.5;

export const ClimaxScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sceneSec = TIMELINE.climax.duration;
  const arrive = pop(frame, fps, 0.05, HEAVY);
  const fade = ramp(frame, fps, 0.05, 0.5, EASE_GLIDE);
  const outP = ramp(frame, fps, sceneSec - 0.8, 0.8, EASE_DRAMA);
  const drift = 12 * ramp(frame, fps, 0, sceneSec, EASE_DRIFT);
  const sweep = ramp(frame, fps, 0.6, 0.7, EASE_GLIDE);

  return (
    <AbsoluteFill style={{ opacity: 1 - outP }}>
      <Backdrop glow={{ x: 960, y: 600, intensity: 0.35, size: 1300 }} particles={22}>
        <Glow x={960} y={600} size={900} intensity={0.25} color="147,197,253" phase={2} />
        <div style={{ position: "absolute", left: FRAME.x + drift, top: FRAME.y, width: FRAME.w, height: FRAME.h, perspective: 1600 }}>
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: 22,
              overflow: "hidden",
              background: "#1b1f1e",
              border: "1px solid rgba(148,163,184,0.2)",
              boxShadow: "0 60px 120px rgba(0,0,0,0.6), 0 0 80px rgba(59,130,246,0.25)",
              opacity: fade,
              transform: `scale(${(1.08 - 0.08 * arrive) * (1 - 0.06 * outP)}) rotateX(${4 * (1 - arrive)}deg)`,
              filter: `blur(${12 * (1 - fade) + 8 * outP}px)`,
              transformOrigin: "50% 60%",
            }}
          >
            <div style={{ height: 52, display: "flex", alignItems: "center", gap: 10, padding: "0 20px", background: "#141817", borderBottom: "1px solid rgba(148,163,184,0.12)" }}>
              {["#EF4444", "#F59E0B", "#22C55E"].map((c) => (
                <div key={c} style={{ width: 13, height: 13, borderRadius: "50%", background: c, opacity: 0.85 }} />
              ))}
              <div style={{ marginLeft: 14, fontFamily: FONT.code, fontSize: 19, color: COLOR.muted }}>anyplex · examples/switch.ts</div>
            </div>
            <div style={{ position: "absolute", left: 0, top: 52, width: FRAME.w, height: FRAME.h - 52, overflow: "hidden" }}>
              <Video src={staticFile("terminal.mp4")} trimBefore={Math.round(TRIM_SEC * fps)} style={{ width: 1580, height: 1120, transform: "scale(0.86)", transformOrigin: "0 0" }} />
            </div>
            <div style={{ position: "absolute", left: 0, right: 0, top: 52, height: 2, background: `linear-gradient(90deg, transparent, ${COLOR.accent}, transparent)` }} />
            <LightSweep progress={sweep} strength={0.3} />
          </div>
        </div>
        <Caption text="Real runs. Real vendors. Real spend." delay={0.5} x={410} y={112} size={44} />
      </Backdrop>
    </AbsoluteFill>
  );
};
