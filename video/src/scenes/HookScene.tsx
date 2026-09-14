// Hook (0–4.5 s): four hosted agent runtimes, four different APIs.
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { Glass } from "../components/Glass";
import { COLOR, FONT, TIMELINE, VENDOR } from "../constants";
import { EASE_DRIFT, enter, exit, PRECISE, ramp, SLAM, stagger, style as entranceStyle } from "../utils/animations";

const CARDS = [
  { vendor: VENDOR[0], x: 180, y: 150, code: "beta.sessions.create({ agent, events })" },
  { vendor: VENDOR[1], x: 1040, y: 110, code: "beta.agents.sessions.create({ environment })" },
  { vendor: VENDOR[2], x: 260, y: 700, code: "interactions.create({ agent, environment })" },
  { vendor: VENDOR[3], x: 1100, y: 660, code: "POST /v1/agents { prompt, repos, mcpServers }" },
];

export const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sceneSec = TIMELINE.hook.duration;
  const out = exit(frame, fps, sceneSec, 0.5);
  const pull = ramp(frame, fps, sceneSec - 0.6, 0.6, EASE_DRIFT);
  const push = 1 + 0.015 * ramp(frame, fps, 0, sceneSec, EASE_DRIFT);

  return (
    <AbsoluteFill style={{ opacity: out.opacity, transform: `scale(${out.scale * push})`, filter: `blur(${out.blur}px)` }}>
      <Backdrop glow={{ x: 960, y: 780, intensity: 0.28 }}>
        {CARDS.map((card, i) => {
          const left = card.x < 960;
          const top = card.y < 500;
          const e = enter(frame, fps, stagger(i, 0.15, 0.13), {
            spring: PRECISE,
            from: { x: left ? -60 : 60, y: top ? -40 : 40, scale: 0.97, blur: 10 },
          });
          const toCenterX = (960 - (card.x + 350)) * 0.12 * pull;
          const toCenterY = (470 - (card.y + 95)) * 0.12 * pull;
          const rotateY = (left ? 8 : -8) * (1 - e.p);
          return (
            <div
              key={card.vendor.id}
              style={{
                position: "absolute",
                left: card.x,
                top: card.y,
                perspective: 1200,
                opacity: e.opacity * (1 - pull),
                filter: `blur(${e.blur + pull * 8}px)`,
                transform: `translate(${e.x + toCenterX}px, ${e.y + toCenterY}px)`,
              }}
            >
              <div style={{ position: "absolute", inset: -40, background: `radial-gradient(circle, ${card.vendor.tint}33 0%, transparent 65%)`, filter: "blur(30px)" }} />
              <Glass x={0} y={0} width={700} height={190} rim="left" rimColor={card.vendor.tint} style={{ position: "relative", transform: `rotateY(${rotateY}deg) scale(${e.scale})` }}>
                <div style={{ padding: "30px 36px", display: "flex", flexDirection: "column", gap: 18 }}>
                  <div style={{ fontFamily: FONT.code, fontSize: 22, color: COLOR.muted, letterSpacing: "0.02em" }}>{card.vendor.label}</div>
                  <div style={{ fontFamily: FONT.code, fontSize: 25, color: COLOR.primary, whiteSpace: "nowrap" }}>{card.code}</div>
                </div>
              </Glass>
            </div>
          );
        })}

        {(() => {
          const line1 = enter(frame, fps, 1.4, { spring: SLAM, from: { y: 0, scale: 0.92, blur: 6 } });
          const line2 = enter(frame, fps, 1.9, { from: { y: 24, scale: 1, blur: 6 } });
          return (
            <div style={{ position: "absolute", left: 0, right: 0, top: 420, textAlign: "center" }}>
              <div style={{ fontFamily: FONT.display, fontWeight: 700, fontSize: 84, letterSpacing: "-0.02em", color: COLOR.primary, lineHeight: 1.1, ...entranceStyle(line1) }}>
                Four hosted agent runtimes.
              </div>
              <div style={{ fontFamily: FONT.display, fontWeight: 500, fontSize: 84, letterSpacing: "-0.02em", color: COLOR.muted, lineHeight: 1.1, marginTop: 10, ...entranceStyle(line2) }}>
                Four different APIs.
              </div>
            </div>
          );
        })()}
      </Backdrop>
    </AbsoluteFill>
  );
};
