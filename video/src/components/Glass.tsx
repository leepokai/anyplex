// Content containers and light: a glass panel, a light sweep, a slam caption, and the small
// brand anchor that persists through the showcase scenes.
import type React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { COLOR, FONT } from "../constants";
import { enter, pulse, SLAM, style as entranceStyle } from "../utils/animations";
import { Mark } from "./Mark";

export const Glass: React.FC<{
  x: number;
  y: number;
  width: number;
  height: number;
  rim?: "left" | "top" | "none";
  rimColor?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ x, y, width, height, rim = "none", rimColor = COLOR.accent, style, children }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width,
      height,
      borderRadius: 22,
      background: "rgba(15,23,42,0.74)",
      border: "1px solid rgba(148,163,184,0.16)",
      boxShadow: "0 40px 90px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)",
      backdropFilter: "blur(18px)",
      overflow: "hidden",
      ...style,
    }}
  >
    {rim === "left" ? (
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: `linear-gradient(180deg, transparent, ${rimColor}, transparent)` }} />
    ) : null}
    {rim === "top" ? (
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 2, background: `linear-gradient(90deg, transparent, ${rimColor}, transparent)` }} />
    ) : null}
    {children}
  </div>
);

/** A diagonal light band crossing its container; `progress` 0..1 moves it left to right. */
export const LightSweep: React.FC<{ progress: number; strength?: number }> = ({ progress, strength = 0.35 }) => {
  if (progress <= 0 || progress >= 1) return null;
  const opacity = Math.sin(progress * Math.PI) * strength;
  return (
    <div
      style={{
        position: "absolute",
        top: "-20%",
        bottom: "-20%",
        left: `${-30 + progress * 160}%`,
        width: "22%",
        transform: "skewX(-18deg)",
        background: `linear-gradient(90deg, rgba(147,197,253,0) 0%, rgba(147,197,253,${opacity}) 50%, rgba(147,197,253,0) 100%)`,
        pointerEvents: "none",
      }}
    />
  );
};

export const Caption: React.FC<{
  text: string;
  delay: number;
  x: number;
  y: number;
  size?: number;
  weight?: 500 | 700;
  color?: string;
  maxWidth?: number;
  children?: React.ReactNode;
}> = ({ text, delay, x, y, size = 54, weight = 700, color = COLOR.primary, maxWidth = 1200, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = enter(frame, fps, delay, { spring: SLAM, from: { y: 18, scale: 0.94, blur: 6 } });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        maxWidth,
        fontFamily: FONT.display,
        fontWeight: weight,
        fontSize: size,
        lineHeight: 1.15,
        letterSpacing: "-0.015em",
        color,
        transformOrigin: "left center",
        ...entranceStyle(e),
      }}
    >
      {children ?? text}
    </div>
  );
};

export const BrandAnchor: React.FC<{ delay?: number }> = ({ delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = enter(frame, fps, delay, { from: { x: -20, y: 0, scale: 0.9, blur: 6 } });
  return (
    <div
      style={{
        position: "absolute",
        left: 100,
        top: 76,
        display: "flex",
        alignItems: "center",
        gap: 16,
        ...entranceStyle(e),
      }}
    >
      <Mark size={56} glow={0.4 * pulse(frame, fps, 0.5, 2.4)} />
      <span style={{ fontFamily: FONT.display, fontWeight: 700, fontSize: 30, letterSpacing: "-0.02em", color: COLOR.primary }}>anyplex</span>
    </div>
  );
};
