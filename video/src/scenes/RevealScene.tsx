// Reveal (4.3–10 s): the strands draw inward, meet at the hub, one line leaves; the wordmark.
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop, Glow } from "../components/Backdrop";
import { LightSweep } from "../components/Glass";
import { Mark, Wordmark } from "../components/Mark";
import { COLOR, FONT, TIMELINE, VENDOR } from "../constants";
import { BOUNCE, EASE_DRIFT, EASE_GLIDE, enter, exit, HEAVY, pop, ramp, SLAM, style as entranceStyle } from "../utils/animations";

const MARK = 700;
const MARK_X = 960 - MARK / 2;
const MARK_Y = 440 - MARK / 2;

export const RevealScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sceneSec = TIMELINE.reveal.duration;
  const out = exit(frame, fps, sceneSec, 0.5);
  const zoom = 1.03 - 0.03 * ramp(frame, fps, 0, sceneSec, EASE_DRIFT);

  const strands = [0, 1, 2, 3].map((i) => ramp(frame, fps, 0.1 + i * 0.12, 0.9, EASE_GLIDE));
  const hub = pop(frame, fps, 1.4, BOUNCE);
  const ring = ramp(frame, fps, 1.45, 0.9, EASE_GLIDE);
  const line = ramp(frame, fps, 1.7, 0.6, EASE_GLIDE);
  const glow = 0.2 + 0.5 * ramp(frame, fps, 1.2, 0.8, EASE_GLIDE);
  const word = enter(frame, fps, 2.2, { spring: SLAM, from: { y: 0, scale: 0.9, blur: 8 } });
  const tracking = -0.08 + 0.06 * word.p;
  const tag = enter(frame, fps, 2.8, { from: { y: 20, scale: 1, blur: 6 } });
  const sweep = ramp(frame, fps, 2.7, 0.9, EASE_GLIDE);

  return (
    <AbsoluteFill style={{ opacity: out.opacity, transform: `scale(${out.scale * zoom})`, filter: `blur(${out.blur}px)` }}>
      <Backdrop glow={{ x: 960, y: 440, intensity: glow, size: 1100 }} particles={36}>
        <Glow x={960} y={440} size={520} intensity={glow * 0.6} color="147,197,253" phase={1} />
        {/* Vendor labels ride the strands and dissolve at the hub. */}
        {VENDOR.map((v, i) => {
          const p = strands[i] ?? 0;
          const scale = MARK / 256;
          const t = Math.min(1, p / 0.85);
          const x0 = 24;
          const y0 = 50 + i * 52;
          const cx = 88;
          const cy = y0;
          const x1 = 118;
          const y1 = 128;
          const bx = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1;
          const by = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1;
          const fade = p <= 0 ? 0 : p > 0.75 ? Math.max(0, 1 - (p - 0.75) / 0.2) : Math.min(1, p / 0.15);
          return (
            <div
              key={v.id}
              style={{
                position: "absolute",
                left: MARK_X + bx * scale - 12,
                top: MARK_Y + by * scale - 52,
                transform: "translateX(-100%)",
                fontFamily: FONT.code,
                fontSize: 22,
                color: v.tint,
                opacity: fade,
                whiteSpace: "nowrap",
                textShadow: `0 0 18px ${v.tint}66`,
              }}
            >
              {v.label}
            </div>
          );
        })}
        <div style={{ position: "absolute", left: MARK_X, top: MARK_Y }}>
          <Mark size={MARK} strands={strands} hub={hub} line={line} ring={ring} glow={glow} />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 760, display: "flex", justifyContent: "center", overflow: "hidden" }}>
          <div style={{ position: "relative", ...entranceStyle(word) }}>
            <Wordmark size={128} tracking={tracking} fontFamily={FONT.display} />
            <LightSweep progress={sweep} strength={0.3} />
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 905,
            textAlign: "center",
            fontFamily: FONT.body,
            fontWeight: 500,
            fontSize: 40,
            color: COLOR.muted,
            letterSpacing: "0.01em",
            ...entranceStyle(tag),
          }}
        >
          LiteLLM for managed agents
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

export { HEAVY };
