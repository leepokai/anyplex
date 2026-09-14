// The anyplex mark (assets/icon.svg) as an animatable SVG: four strands that draw in, a hub
// that pops, a line that leaves, and an optional expanding ring.
import type React from "react";
import { COLOR } from "../constants";

const STRANDS = [
  "M24 50 Q88 50 118 128",
  "M24 102 Q88 102 118 128",
  "M24 154 Q88 154 118 128",
  "M24 206 Q88 206 118 128",
];

export const Mark: React.FC<{
  size: number;
  strands?: number[];
  hub?: number;
  line?: number;
  ring?: number;
  strandColor?: string;
  accent?: string;
  glow?: number;
  style?: React.CSSProperties;
}> = ({
  size,
  strands = [1, 1, 1, 1],
  hub = 1,
  line = 1,
  ring = 0,
  strandColor = COLOR.primary,
  accent = COLOR.accent,
  glow = 0,
  style,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 256 256"
    fill="none"
    strokeLinecap="round"
    style={{ overflow: "visible", filter: glow > 0 ? `drop-shadow(0 0 ${28 * glow}px rgba(59,130,246,${0.7 * glow}))` : undefined, ...style }}
  >
    <title>anyplex</title>
    {ring > 0 && ring < 1 ? (
      <circle
        cx={118}
        cy={128}
        r={44 + ring * 280}
        stroke={COLOR.highlight}
        strokeWidth={3 * (1 - ring) + 0.5}
        opacity={0.8 * (1 - ring)}
      />
    ) : null}
    <g stroke={strandColor} strokeWidth={24}>
      {STRANDS.map((d, i) => (
        <path
          key={d}
          d={d}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - Math.max(0, Math.min(1, strands[i] ?? 1))}
          opacity={strands[i] && strands[i] > 0 ? 1 : 0}
        />
      ))}
    </g>
    <path
      d="M118 128 H228"
      stroke={accent}
      strokeWidth={36}
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - Math.max(0, Math.min(1, line))}
      opacity={line > 0 ? 1 : 0}
    />
    <circle cx={118} cy={128} r={44} fill={accent} transform={`translate(118 128) scale(${Math.max(0, hub)}) translate(-118 -128)`} />
  </svg>
);

export const Wordmark: React.FC<{ size: number; tracking?: number; style?: React.CSSProperties; fontFamily: string }> = ({
  size,
  tracking = -0.02,
  style,
  fontFamily,
}) => (
  <div
    style={{
      fontFamily,
      fontWeight: 700,
      fontSize: size,
      letterSpacing: `${tracking}em`,
      color: COLOR.primary,
      lineHeight: 1,
      ...style,
    }}
  >
    anyplex
  </div>
);
