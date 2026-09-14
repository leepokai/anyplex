// Palette, fonts, and the scene timeline of the launch video. Roles, not just colors: see
// storyboard.json for the storyboard this implements.
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadGrotesk } from "@remotion/google-fonts/SpaceGrotesk";

const grotesk = loadGrotesk("normal", { weights: ["400", "500", "700"], subsets: ["latin"] });
const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

export const FONT = {
  display: grotesk.fontFamily,
  body: grotesk.fontFamily,
  code: mono.fontFamily,
};

export const COLOR = {
  background: "#070B14",
  surface: "#0F172A",
  border: "#1E293B",
  primary: "#F8FAFC",
  muted: "#94A3B8",
  accent: "#3B82F6",
  accentDeep: "#2563EB",
  highlight: "#93C5FD",
  ink: "#0F172A",
};

export const VENDOR = [
  { id: "anthropic", label: "Anthropic Managed Agents", tint: "#D97706", route: "anthropic/claude-haiku-4-5" },
  { id: "openai", label: "OpenAI Agents API", tint: "#10B981", route: "openai/gpt-6-astra" },
  { id: "google", label: "Gemini Managed Agents", tint: "#F43F5E", route: "google/gemini-3.8-flash" },
  { id: "cursor", label: "Cursor Cloud Agents", tint: "#A855F7", route: "cursor/claude-haiku-4-5" },
] as const;

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** Scene starts and durations in seconds; adjacent scenes overlap by 0.2 s for the handoffs. */
export const TIMELINE = {
  hook: { start: 0, duration: 4.5 },
  reveal: { start: 4.3, duration: 5.7 },
  code: { start: 10, duration: 7.5 },
  events: { start: 17.2, duration: 7 },
  capabilities: { start: 24, duration: 6.5 },
  climax: { start: 30.3, duration: 6 },
  close: { start: 36, duration: 4 },
} as const;

export const DURATION_SEC = 40;
