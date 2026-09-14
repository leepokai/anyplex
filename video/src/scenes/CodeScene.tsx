// Showcase 1 (10–17.5 s): one definition, one call; only the route string changes.
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { Caption, Glass } from "../components/Glass";
import { COLOR, FONT, TIMELINE, VENDOR } from "../constants";
import { caretOn, EASE_DRAMA, EASE_SNAP, enter, PRECISE, ramp, stagger, typed, style as entranceStyle } from "../utils/animations";

type Seg = { t: string; c: string };
const K = "#60A5FA";
const P = COLOR.primary;
const M = COLOR.muted;
const S = COLOR.highlight;

const LINES: Seg[][] = [
  [{ t: "const ", c: K }, { t: "agent", c: P }, { t: " = ", c: M }, { t: "anyplex", c: P }, { t: "({", c: M }],
  [{ t: "  model", c: P }, { t: ": ", c: M }, { t: "ROUTE", c: S }, { t: ",", c: M }],
  [{ t: "  apiKey", c: P }, { t: ", ", c: M }, { t: "instructions", c: P }, { t: ",", c: M }],
  [{ t: "});", c: M }],
  [{ t: "const ", c: K }, { t: "session", c: P }, { t: " = ", c: M }, { t: "await ", c: K }, { t: "agent", c: P }, { t: ".start({ prompt, budgetUsd: 0.5 });", c: M }],
  [{ t: "for await ", c: K }, { t: "(", c: M }, { t: "const ", c: K }, { t: "event", c: P }, { t: " of ", c: K }, { t: "session", c: P }, { t: ".events()) render(event);", c: M }],
];

const WIN = { x: 140, y: 260, w: 1150, h: 520 };
const PILL = { x: 1330, y: 330, w: 490, h: 64, gap: 88 };
const SWAP_START = 3.4;
const SWAP_EVERY = 0.8;

export const CodeScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const sceneSec = TIMELINE.code.duration;
  const win = enter(frame, fps, 0.05, { spring: PRECISE, from: { x: -80, y: 0, scale: 0.98, blur: 8 } });
  const outP = ramp(frame, fps, sceneSec - 0.4, 0.4, EASE_DRAMA);

  const activeIndex = Math.min(VENDOR.length - 1, Math.max(0, Math.floor((t - SWAP_START) / SWAP_EVERY) + 1));
  const sinceSwap = t < SWAP_START ? 1 : (t - SWAP_START) % SWAP_EVERY;
  const swapP = t < SWAP_START ? 1 : Math.min(1, sinceSwap / 0.35);
  const swapEase = EASE_SNAP(swapP);
  const route = VENDOR[activeIndex]?.route ?? VENDOR[0].route;
  const previous = VENDOR[Math.max(0, activeIndex - 1)]?.route ?? route;

  // Typewriter over the full text, with the initial route in place of the ROUTE token.
  const full = LINES.map((line) => line.map((s) => (s.t === "ROUTE" ? `"${VENDOR[0].route}"` : s.t)).join("")).join("\n");
  const visible = typed(frame, fps, 0.4, full, 46);
  const typingDone = visible.length >= full.length;
  let cursor = 0;

  return (
    <AbsoluteFill style={{ opacity: 1 - outP }}>
      <Backdrop glow={{ x: 700, y: 520, intensity: 0.26, size: 1000 }} particles={24}>
        <div
          style={{
            position: "absolute",
            left: WIN.x,
            top: WIN.y,
            width: WIN.w,
            height: WIN.h,
            opacity: win.opacity,
            transform: `translate(${win.x}px, ${60 * outP}px) scale(${win.scale})`,
            filter: `blur(${win.blur + 6 * outP}px)`,
          }}
        >
          <Glass x={0} y={0} width={WIN.w} height={WIN.h} rim="left" style={{ position: "relative" }}>
            <div style={{ display: "flex", gap: 10, padding: "20px 26px 0" }}>
              {["#EF4444", "#F59E0B", "#22C55E"].map((c) => (
                <div key={c} style={{ width: 13, height: 13, borderRadius: "50%", background: c, opacity: 0.8 }} />
              ))}
              <div style={{ marginLeft: 16, fontFamily: FONT.code, fontSize: 20, color: COLOR.muted }}>agent.ts</div>
            </div>
            <div style={{ padding: "26px 40px 0", fontFamily: FONT.code, fontSize: 28, lineHeight: 1.65, whiteSpace: "pre" }}>
              {LINES.map((line, li) => {
                const nodes: React.ReactNode[] = [];
                for (const seg of line) {
                  if (seg.t === "ROUTE") {
                    const text = `"${VENDOR[0].route}"`;
                    const shown = visible.slice(cursor, cursor + text.length);
                    cursor += text.length;
                    if (!typingDone) {
                      nodes.push(<span key={`${li}-route`} style={{ color: S }}>{shown}</span>);
                    } else {
                      nodes.push(
                        <span key={`${li}-route`} style={{ position: "relative", display: "inline-block", color: S }}>
                          <span style={{ visibility: "hidden" }}>{`"${route}"`}</span>
                          <span style={{ position: "absolute", left: 0, top: 0, opacity: 1 - swapEase, transform: `translateY(${-14 * swapEase}px)`, filter: `blur(${4 * swapEase}px)` }}>{`"${previous}"`}</span>
                          <span style={{ position: "absolute", left: 0, top: 0, opacity: swapEase, transform: `translateY(${-14 * (1 - swapEase)}px)`, filter: `blur(${4 * (1 - swapEase)}px)`, textShadow: `0 0 18px ${COLOR.highlight}88` }}>{`"${route}"`}</span>
                        </span>,
                      );
                    }
                  } else {
                    const shown = visible.slice(cursor, cursor + seg.t.length);
                    cursor += seg.t.length;
                    nodes.push(<span key={`${li}-${cursor}`} style={{ color: seg.c }}>{shown}</span>);
                  }
                }
                cursor += 1; // newline
                const isCaretLine = !typingDone && visible.length <= cursor - 1 && visible.length >= cursor - 1 - line.reduce((n, s) => n + (s.t === "ROUTE" ? VENDOR[0].route.length + 2 : s.t.length), 0);
                return (
                  <div key={li}>
                    {nodes}
                    {isCaretLine && caretOn(frame, fps) ? <span style={{ color: COLOR.highlight }}>▍</span> : null}
                  </div>
                );
              })}
            </div>
          </Glass>
        </div>

        {/* Route pills on the right; the active one lights up and a strand streaks to the code. */}
        {VENDOR.map((v, i) => {
          const e = enter(frame, fps, stagger(i, 1.0, 0.11), { spring: PRECISE, from: { x: 40, y: 0, scale: 0.98, blur: 8 } });
          const active = typingDone && i === activeIndex;
          const activeP = active ? swapEase : 0;
          const y = PILL.y + i * PILL.gap;
          return (
            <div key={v.id} style={{ position: "absolute", left: PILL.x, top: y, width: PILL.w, height: PILL.h, opacity: e.opacity * (1 - outP), transform: `translateX(${e.x}px) scale(${e.scale})`, filter: `blur(${e.blur}px)` }}>
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  borderRadius: 32,
                  border: `1px solid ${active ? COLOR.highlight : "rgba(148,163,184,0.2)"}`,
                  background: `rgba(59,130,246,${0.06 + 0.2 * activeP})`,
                  boxShadow: active ? `0 0 ${30 * activeP}px rgba(59,130,246,${0.45 * activeP})` : undefined,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "0 24px",
                  fontFamily: FONT.code,
                  fontSize: 24,
                  whiteSpace: "nowrap",
                  color: active ? COLOR.primary : COLOR.muted,
                }}
              >
                <div style={{ width: 12, height: 12, borderRadius: "50%", background: v.tint, boxShadow: `0 0 12px ${v.tint}` }} />
                {v.route}
              </div>
            </div>
          );
        })}
        {typingDone ? (
          <svg style={{ position: "absolute", inset: 0, pointerEvents: "none" }} width={1920} height={1080}>
            <title>route streak</title>
            <path
              d={`M ${PILL.x} ${PILL.y + activeIndex * PILL.gap + PILL.h / 2} C ${PILL.x - 60} ${PILL.y + activeIndex * PILL.gap + PILL.h / 2}, ${WIN.x + WIN.w + 60} ${WIN.y + 158}, ${WIN.x + WIN.w} ${WIN.y + 158}`}
              stroke={COLOR.highlight}
              strokeWidth={2}
              fill="none"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - swapEase}
              opacity={(1 - Math.max(0, (sinceSwap - 0.35) / 0.35)) * 0.9}
            />
          </svg>
        ) : null}

        <Caption text="Change a route string, not your code." delay={3.6} x={140} y={860} />
      </Backdrop>
    </AbsoluteFill>
  );
};

export const codeScenePills = (): { x: number; y: number }[] => VENDOR.map((_, i) => ({ x: PILL.x, y: PILL.y + i * PILL.gap }));
export const CODE_ENTRANCE = { style: entranceStyle };
