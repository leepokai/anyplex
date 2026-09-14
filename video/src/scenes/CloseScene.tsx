// Close (36–40 s): mark, wordmark, the install line, the link.
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { Mark, Wordmark } from "../components/Mark";
import { COLOR, FONT, VENDOR } from "../constants";
import { caretOn, EASE_GLIDE, enter, HEAVY, pop, pulse, ramp, SLAM, style as entranceStyle, typed } from "../utils/animations";

const MARK = 420;

export const CloseScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ring = ramp(frame, fps, 0, 1.1, EASE_GLIDE);
  const markP = pop(frame, fps, 0.05, HEAVY);
  const markFade = ramp(frame, fps, 0.05, 0.5, EASE_GLIDE);
  const word = enter(frame, fps, 0.4, { spring: SLAM, from: { y: 0, scale: 0.9, blur: 8 } });
  const cmd = "npm i anyplex";
  const shown = typed(frame, fps, 0.9, cmd, 40);
  const done = shown.length >= cmd.length;
  const pillGlow = done ? ramp(frame, fps, 0.9 + cmd.length / 40, 0.5, EASE_GLIDE) : 0;
  const link = enter(frame, fps, 1.6, { from: { y: 20, scale: 1, blur: 6 } });
  const glow = 0.3 + 0.1 * pulse(frame, fps, 1, 3);

  return (
    <AbsoluteFill>
      <Backdrop glow={{ x: 960, y: 420, intensity: glow, size: 1100 }} particles={34} grid={0.05}>
        {ring < 1 ? (
          <svg style={{ position: "absolute", inset: 0 }} width={1920} height={1080}>
            <title>ring</title>
            <circle cx={960} cy={420} r={ring * 900} stroke={COLOR.highlight} strokeWidth={2.5 * (1 - ring) + 0.5} fill="none" opacity={0.5 * (1 - ring)} />
          </svg>
        ) : null}
        <div style={{ position: "absolute", left: 960 - MARK / 2, top: 400 - MARK / 2, opacity: markFade, transform: `scale(${0.6 + 0.4 * markP})`, filter: `blur(${10 * (1 - markFade)}px)` }}>
          <Mark size={MARK} glow={0.8} />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 640, display: "flex", justifyContent: "center" }}>
          <div style={entranceStyle(word)}>
            <Wordmark size={112} fontFamily={FONT.display} />
          </div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 790, display: "flex", justifyContent: "center" }}>
          <div
            style={{
              padding: "16px 34px",
              borderRadius: 999,
              border: `1px solid rgba(147,197,253,${0.3 + 0.6 * pillGlow})`,
              background: "rgba(15,23,42,0.8)",
              boxShadow: `0 0 ${36 * pillGlow}px rgba(59,130,246,${0.5 * pillGlow})`,
              fontFamily: FONT.code,
              fontSize: 40,
              color: COLOR.primary,
              opacity: frame / fps >= 0.9 ? 1 : 0,
              minWidth: 380,
              textAlign: "left",
            }}
          >
            <span style={{ color: COLOR.muted }}>$ </span>
            {shown}
            {!done && caretOn(frame, fps) ? <span style={{ color: COLOR.highlight }}>▍</span> : null}
          </div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 900, textAlign: "center", fontFamily: FONT.body, fontWeight: 500, fontSize: 30, color: COLOR.muted, ...entranceStyle(link) }}>
          github.com/leepokai/anyplex
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 960, textAlign: "center", fontFamily: FONT.code, fontSize: 24 }}>
          {VENDOR.map((v, i) => {
            const o = ramp(frame, fps, 2.0 + i * 0.12, 0.35, EASE_GLIDE);
            return (
              <span key={v.id} style={{ color: v.tint, opacity: o }}>
                {v.id}
                {i < VENDOR.length - 1 ? <span style={{ color: COLOR.muted }}>{"  ·  "}</span> : null}
              </span>
            );
          })}
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};
