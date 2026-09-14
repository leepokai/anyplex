// Showcase 2 (17.2–24.2 s): one event stream, spend that is the vendor's figure, a budget.
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { Caption, Glass, LightSweep } from "../components/Glass";
import { COLOR, FONT, TIMELINE } from "../constants";
import { EASE_DRAMA, EASE_DRIFT, EASE_GLIDE, enter, PRECISE, pulse, ramp, stagger, style as entranceStyle } from "../utils/animations";

const ROWS = [
  { type: "tool.call", payload: "bash  date && uname -s", tone: COLOR.primary },
  { type: "tool.result", payload: "ok", tone: "#34D399" },
  { type: "message.delta", payload: "Done.", tone: COLOR.primary },
  { type: "spend.updated", payload: "$0.0063 settled", tone: COLOR.highlight },
  { type: "session.ended", payload: "completed", tone: "#34D399" },
];
const ROW_BASE = 0.5;
const ROW_STEP = 0.55;
const SPEND_AT = ROW_BASE + 3 * ROW_STEP;
const END_AT = ROW_BASE + 4 * ROW_STEP;

export const EventsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sceneSec = TIMELINE.events.duration;
  const outP = ramp(frame, fps, sceneSec - 0.45, 0.45, EASE_DRAMA);
  const push = 1 + 0.02 * ramp(frame, fps, 0, sceneSec, EASE_DRIFT);
  const ledger = enter(frame, fps, 0.05, { spring: PRECISE, from: { x: 0, y: 80, scale: 0.98, blur: 8 } });
  const meter = enter(frame, fps, SPEND_AT, { spring: PRECISE, from: { x: 50, y: 0, scale: 0.96, blur: 8 } });
  const count = 0.0063 * ramp(frame, fps, SPEND_AT + 0.1, 0.8, EASE_GLIDE);
  const endPulse = ramp(frame, fps, END_AT, 0.6, EASE_GLIDE);
  const borderGlow = Math.sin(endPulse * Math.PI);

  return (
    <AbsoluteFill style={{ opacity: 1 - outP, transform: `scale(${(1 - 0.06 * outP) * push})`, filter: `blur(${8 * outP}px)` }}>
      <Backdrop glow={{ x: 1400, y: 460, intensity: 0.22, size: 900 }} particles={26}>
        <div style={{ position: "absolute", left: 140, top: 240, width: 980, height: 560, ...entranceStyle(ledger) }}>
          <Glass
            x={0}
            y={0}
            width={980}
            height={560}
            rim="top"
            style={{ position: "relative", boxShadow: `0 40px 90px rgba(0,0,0,0.5), 0 0 ${40 * borderGlow}px rgba(59,130,246,${0.5 * borderGlow})`, borderColor: `rgba(147,197,253,${0.16 + 0.5 * borderGlow})` }}
          >
            <div style={{ padding: "26px 36px 0", fontFamily: FONT.code, fontSize: 20, color: COLOR.muted, display: "flex", justifyContent: "space-between" }}>
              <span>session.events()</span>
              <span>anthropic/claude-haiku-4-5</span>
            </div>
            <div style={{ padding: "22px 36px 0", display: "flex", flexDirection: "column", gap: 18 }}>
              {ROWS.map((row, i) => {
                const delay = stagger(i, ROW_BASE, ROW_STEP);
                const e = enter(frame, fps, delay, { spring: PRECISE, from: { x: 0, y: 24, scale: 1, blur: 6 } });
                const sweep = ramp(frame, fps, delay + 0.1, 0.6, EASE_GLIDE);
                return (
                  <div key={row.type} style={{ position: "relative", display: "flex", alignItems: "center", gap: 28, height: 66, padding: "0 22px", borderRadius: 14, background: "rgba(148,163,184,0.05)", overflow: "hidden", ...entranceStyle(e) }}>
                    <span style={{ fontFamily: FONT.code, fontSize: 27, color: COLOR.muted, width: 300 }}>{row.type}</span>
                    <span style={{ fontFamily: FONT.code, fontSize: 27, color: row.tone }}>{row.payload}</span>
                    <LightSweep progress={sweep} strength={0.25} />
                  </div>
                );
              })}
            </div>
          </Glass>
        </div>

        <div style={{ position: "absolute", left: 1220, top: 300, width: 560, height: 300, ...entranceStyle(meter) }}>
          <Glass x={0} y={0} width={560} height={300} rim="left" rimColor={COLOR.highlight} style={{ position: "relative" }}>
            <div style={{ padding: "34px 40px 0" }}>
              <div style={{ fontFamily: FONT.code, fontSize: 20, color: COLOR.muted, letterSpacing: "0.04em" }}>SPEND · SETTLED</div>
              <div style={{ fontFamily: FONT.display, fontWeight: 700, fontSize: 92, letterSpacing: "-0.03em", color: COLOR.primary, lineHeight: 1.1, marginTop: 6 }}>
                ${count.toFixed(4)}
              </div>
              <div style={{ position: "relative", marginTop: 22, height: 8, borderRadius: 4, background: "rgba(148,163,184,0.16)" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.max(1.4, (count / 0.5) * 100)}%`, borderRadius: 4, background: COLOR.highlight, boxShadow: `0 0 ${18 * pulse(frame, fps, 0.5, 1.6)}px ${COLOR.highlight}` }} />
              </div>
              <div style={{ marginTop: 16, fontFamily: FONT.code, fontSize: 20, color: COLOR.muted }}>budget $0.50 · watchdog armed</div>
            </div>
          </Glass>
        </div>

        <Caption text="One event stream. Spend that's actually right." delay={3.8} x={140} y={860} />
      </Backdrop>
    </AbsoluteFill>
  );
};
