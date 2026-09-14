#!/usr/bin/env python3
"""Synthesize the launch video's music bed: a slow minor pad, a sub bass, a soft pulse, and
a plucked arpeggio that follows the scene beats (see storyboard.json). License-free by
construction. Writes public/music.wav (40 s, 44.1 kHz, stereo).

    python3 scripts/music.py
"""
from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfilt

SR = 44100
DURATION = 40.0
BPM = 96
BEAT = 60 / BPM
N = int(SR * DURATION)
t = np.arange(N) / SR

# A minor-ish "midnight" progression, two bars per chord: Am, F, C, G (in Hz, root octave 2/3)
CHORDS = [
    ("A", [110.00, 130.81, 164.81, 220.00]),  # A2 C3 E3 A3
    ("F", [87.31, 130.81, 174.61, 220.00]),   # F2 C3 F3 A3
    ("C", [98.00, 130.81, 164.81, 196.00]),   # G2 C3 E3 G3 (C/G)
    ("G", [98.00, 123.47, 146.83, 196.00]),   # G2 B2 D3 G3
]
BAR = 4 * BEAT
CHORD_LEN = 2 * BAR


def lowpass(x: np.ndarray, hz: float, order: int = 4) -> np.ndarray:
    sos = butter(order, hz / (SR / 2), btype="low", output="sos")
    return sosfilt(sos, x)


def highpass(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    sos = butter(order, hz / (SR / 2), btype="high", output="sos")
    return sosfilt(sos, x)


def env_adsr(length: int, a: float, d: float, s: float, r: float) -> np.ndarray:
    e = np.zeros(length)
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    a_n = max(1, min(a_n, length))
    e[:a_n] = np.linspace(0, 1, a_n)
    d_end = min(length, a_n + d_n)
    if d_end > a_n:
        e[a_n:d_end] = np.linspace(1, s, d_end - a_n)
    e[d_end:] = s
    if r_n > 0 and r_n < length:
        e[-r_n:] *= np.linspace(1, 0, r_n)
    return e


def chord_at(time: float):
    return CHORDS[int(time // CHORD_LEN) % len(CHORDS)][1]


# --- pad: detuned saw-ish layers, low-passed, slow attack, per chord ------------------------
pad = np.zeros(N)
for ci in range(int(math.ceil(DURATION / CHORD_LEN))):
    start = ci * CHORD_LEN
    end = min(DURATION, start + CHORD_LEN + 0.6)  # small overlap for legato
    s, e = int(start * SR), int(end * SR)
    seg_t = t[s:e] - start
    seg = np.zeros(e - s)
    for f in chord_at(start + 0.01)[1:]:
        for detune in (-0.4, 0.0, 0.4):
            fr = f * (2 ** (detune / 1200)) * 2  # one octave up for air
            # band-limited saw approximation: sum of 12 harmonics
            wave_ = sum(np.sin(2 * math.pi * fr * k * seg_t) / k for k in range(1, 13))
            seg += wave_ / 3
    seg *= env_adsr(e - s, 1.2, 0.5, 0.85, 0.7)
    pad[s:e] += seg
pad = lowpass(pad, 1400)
pad *= 0.045

# --- sub bass: root note sine, gently pulsing with the beat --------------------------------
sub = np.zeros(N)
for ci in range(int(math.ceil(DURATION / CHORD_LEN))):
    start = ci * CHORD_LEN
    end = min(DURATION, start + CHORD_LEN)
    s, e = int(start * SR), int(end * SR)
    seg_t = t[s:e] - start
    root = chord_at(start + 0.01)[0]
    beat_pulse = 0.75 + 0.25 * np.clip(np.cos(2 * math.pi * seg_t / BEAT), 0, 1)
    sub[s:e] = np.sin(2 * math.pi * root * seg_t) * env_adsr(e - s, 0.3, 0.2, 0.9, 0.4) * beat_pulse
sub = lowpass(sub, 160)
sub *= 0.22

# --- pulse: soft filtered noise tick on every beat, brighter on the downbeat ---------------
rng = np.random.default_rng(7)
pulse = np.zeros(N)
tick_len = int(0.09 * SR)
tick_env = np.exp(-np.linspace(0, 8, tick_len))
for b in range(int(DURATION / BEAT)):
    s = int(b * BEAT * SR)
    e = min(N, s + tick_len)
    noise = rng.standard_normal(e - s)
    noise = highpass(noise, 2500 if b % 4 == 0 else 5000)
    pulse[s:e] += noise * tick_env[: e - s] * (0.32 if b % 4 == 0 else 0.16)
pulse *= 0.035

# --- pluck arpeggio: 8th notes climbing the chord, sine with fast decay -------------------
pluck = np.zeros(N)
step = BEAT / 2
note_len = int(0.42 * SR)
for i in range(int(DURATION / step)):
    start = i * step
    if start < 4.0:  # quiet hook, arpeggio joins at the reveal
        continue
    s = int(start * SR)
    e = min(N, s + note_len)
    tones = chord_at(start)[1:] + [chord_at(start)[1] * 2]
    f = tones[i % len(tones)] * 2
    seg_t = t[s:e] - start
    tone = np.sin(2 * math.pi * f * seg_t) + 0.35 * np.sin(2 * math.pi * f * 2 * seg_t)
    pluck[s:e] += tone * np.exp(-seg_t * 9) * (0.9 if i % 2 == 0 else 0.6)
pluck = lowpass(pluck, 4200)
pluck *= 0.05

# --- swells on the two reveals (4.3 s, 30.3 s): filtered noise rising into the hit ---------
swell = np.zeros(N)
for at in (4.3, 30.3):
    length = int(1.6 * SR)
    s = max(0, int(at * SR) - length)
    e = int(at * SR)
    noise = rng.standard_normal(e - s)
    ramp = np.linspace(0, 1, e - s) ** 2.2
    swell[s:e] += lowpass(noise, 900) * ramp * 0.09
    # a soft low hit at the moment itself
    hit_len = int(0.9 * SR)
    hs, he = e, min(N, e + hit_len)
    ht = t[hs:he] - at
    swell[hs:he] += np.sin(2 * math.pi * 55 * ht) * np.exp(-ht * 4) * 0.3

mix = pad + sub + pulse + pluck + swell

# master envelope: fade in, gentle duck under the climax, fade out over the close
master = np.ones(N)
master *= np.clip(t / 1.2, 0, 1)
master *= np.where(t > 36.5, np.clip((DURATION - t) / 3.5, 0, 1), 1)
mix *= master

# stereo: slightly different filtering per side for width, soft limiter
left = lowpass(mix, 9000) + 0.02 * np.roll(pad, int(0.011 * SR))
right = lowpass(mix, 8500) + 0.02 * np.roll(pad, -int(0.013 * SR))
stereo = np.stack([left, right], axis=1)
peak = np.max(np.abs(stereo))
stereo = np.tanh(stereo / peak * 1.6) / math.tanh(1.6) * 0.8

out = Path(__file__).resolve().parent.parent / "public" / "music.wav"
with wave.open(str(out), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype(np.int16).tobytes())
print(f"wrote {out} ({DURATION:.0f}s, peak {peak:.3f})")
