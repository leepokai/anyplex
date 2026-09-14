// Layers 1–4 and 7 of every scene: gradient, dot grid, one pulsing glow, drifting particles,
// film grain. All motion is a function of the frame.
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { COLOR } from "../constants";
import { float, pulse } from "../utils/animations";

const seeded = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export const Particles: React.FC<{ count?: number; opacity?: number }> = ({ count = 28, opacity = 0.35 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {Array.from({ length: count }, (_, i) => {
        const x = seeded(i, 1) * width + float(frame, fps, 12, 7 + seeded(i, 2) * 5, i);
        const speed = 18 + seeded(i, 3) * 22;
        const y = ((seeded(i, 4) * height - t * speed) % height + height) % height;
        const size = 1.5 + seeded(i, 5) * 2.5;
        const twinkle = 0.5 + 0.5 * Math.sin(t * (1 + seeded(i, 6)) * 2 + i);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: size,
              height: size,
              borderRadius: "50%",
              background: COLOR.highlight,
              opacity: opacity * twinkle,
              filter: "blur(0.5px)",
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

export const Noise: React.FC<{ opacity?: number }> = ({ opacity = 0.045 }) => (
  <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "overlay", opacity }}>
    <svg width="100%" height="100%">
      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  </AbsoluteFill>
);

export const Glow: React.FC<{ x: number; y: number; size?: number; intensity: number; color?: string; phase?: number }> = ({
  x,
  y,
  size = 900,
  intensity,
  color = "59,130,246",
  phase = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: "50%",
        background: `radial-gradient(circle, rgba(${color},${intensity}) 0%, rgba(${color},0) 62%)`,
        transform: `scale(${pulse(frame, fps, 0.05, 3, phase)})`,
        filter: "blur(30px)",
        pointerEvents: "none",
      }}
    />
  );
};

export const Backdrop: React.FC<{
  glow?: { x: number; y: number; intensity: number; size?: number };
  particles?: number;
  grid?: number;
  children?: React.ReactNode;
}> = ({ glow = { x: 960, y: 760, intensity: 0.3 }, particles = 28, grid = 0.06, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          background: `radial-gradient(1300px 900px at 50% 28%, #0B1324 0%, ${COLOR.background} 58%, #04070E 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(circle, rgba(148,163,184,${grid}) 1px, transparent 1.6px)`,
          backgroundSize: "44px 44px",
          backgroundPosition: `${float(frame, fps, 6, 9)}px ${float(frame, fps, 4, 11, 1)}px`,
          maskImage: "radial-gradient(ellipse at center, black 40%, transparent 85%)",
        }}
      />
      <Glow x={glow.x} y={glow.y} intensity={glow.intensity} size={glow.size} />
      <Particles count={particles} />
      {children}
      <Noise />
    </AbsoluteFill>
  );
};
