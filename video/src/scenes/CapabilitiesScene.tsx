// Showcase 3 (24–30.5 s): the rest of what an application needs, orbiting the hub.
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { Caption } from "../components/Glass";
import { Mark } from "../components/Mark";
import { COLOR, FONT, TIMELINE, VENDOR } from "../constants";
import { EASE_DRAMA, EASE_DRIFT, EASE_GLIDE, enter, PRECISE, pulse, ramp, stagger } from "../utils/animations";

const ITEMS = ["stop() reaches the vendor", "attach() after a restart", "budget watchdog", "artifacts in, artifacts out", "fakes for every vendor"];
const CENTER = { x: 960, y: 470 };
const RX = 560;
const RY = 250;
const MARK = 300;

export const CapabilitiesScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sceneSec = TIMELINE.capabilities.duration;
  const outP = ramp(frame, fps, sceneSec - 0.45, 0.45, EASE_DRAMA);
  const drift = (ramp(frame, fps, 0, sceneSec, EASE_DRIFT) * 6 * Math.PI) / 180;
  const hubScale = pulse(frame, fps, 0.04, 1.25);

  return (
    <AbsoluteFill style={{ opacity: 1 - outP }}>
      <Backdrop glow={{ x: CENTER.x, y: CENTER.y, intensity: 0.34, size: 1000 }} particles={30}>
        <svg style={{ position: "absolute", inset: 0, pointerEvents: "none" }} width={1920} height={1080}>
          <title>strands</title>
          {ITEMS.map((item, i) => {
            const angle = -Math.PI / 2 + (i / ITEMS.length) * Math.PI * 2 + drift;
            const x = CENTER.x + Math.cos(angle) * RX;
            const y = CENTER.y + Math.sin(angle) * RY;
            const draw = ramp(frame, fps, stagger(i, 0.75, 0.12), 0.5, EASE_GLIDE) * (1 - outP);
            return <line key={item} x1={CENTER.x} y1={CENTER.y} x2={x} y2={y} stroke={COLOR.accent} strokeWidth={2} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} opacity={0.35} />;
          })}
        </svg>

        <div style={{ position: "absolute", left: CENTER.x - MARK / 2, top: CENTER.y - MARK / 2, transform: `scale(${hubScale * (1 + 0.5 * outP)})`, filter: `blur(${10 * outP}px)` }}>
          <Mark size={MARK} glow={0.7} />
        </div>

        {ITEMS.map((item, i) => {
          const angle = -Math.PI / 2 + (i / ITEMS.length) * Math.PI * 2 + drift;
          const tx = CENTER.x + Math.cos(angle) * RX;
          const ty = CENTER.y + Math.sin(angle) * RY;
          const e = enter(frame, fps, stagger(i, 0.3, 0.12), { spring: PRECISE, from: { x: 0, y: 0, scale: 0.4, blur: 10 } });
          const p = e.p * (1 - outP);
          const x = CENTER.x + (tx - CENTER.x) * p;
          const y = CENTER.y + (ty - CENTER.y) * p;
          const facing = Math.cos(angle) < 0 ? "right" : "left";
          return (
            <div
              key={item}
              style={{
                position: "absolute",
                left: x,
                top: y,
                transform: `translate(-50%, -50%) scale(${0.4 + 0.6 * p})`,
                opacity: e.opacity * (1 - outP),
                filter: `blur(${e.blur + 10 * outP}px)`,
                padding: "18px 30px",
                borderRadius: 999,
                background: "rgba(15,23,42,0.8)",
                border: "1px solid rgba(148,163,184,0.2)",
                boxShadow: `0 20px 50px rgba(0,0,0,0.45), ${facing === "left" ? "-" : ""}6px 0 24px -12px rgba(59,130,246,0.7)`,
                fontFamily: FONT.display,
                fontWeight: 500,
                fontSize: 32,
                color: COLOR.primary,
                whiteSpace: "nowrap",
              }}
            >
              {item}
            </div>
          );
        })}

        <Caption text="" delay={2.6} x={0} y={880} size={44} weight={500} maxWidth={1920}>
          <div style={{ width: 1920, textAlign: "center", color: COLOR.muted }}>
            Verified live on{" "}
            {VENDOR.map((v, i) => {
              const lit = ramp(frame, fps, 2.9 + i * 0.15, 0.3, EASE_GLIDE);
              const name = v.label.split(" ")[0];
              return (
                <span key={v.id} style={{ color: lit > 0.5 ? v.tint : COLOR.muted, textShadow: `0 0 ${14 * lit}px ${v.tint}66`, fontWeight: 700 }}>
                  {name}
                  {i < VENDOR.length - 2 ? ", " : i === VENDOR.length - 2 ? " and " : "."}
                </span>
              );
            })}
          </div>
        </Caption>
      </Backdrop>
    </AbsoluteFill>
  );
};
