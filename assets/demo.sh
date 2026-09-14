#!/usr/bin/env zsh
# Scripted terminal demo for the launch recording. Types each command with a human cadence,
# then runs it for real (two vendors live, about two cents; keys from the repo's .env).
#   asciinema rec -c "zsh assets/demo.sh" --cols 100 --rows 22 --overwrite assets/launch.cast
#   agg --font-size 18 --theme monokai assets/launch.cast assets/launch.gif
set -e
cd "$(dirname "$0")/.."
export CLICOLOR_FORCE=1 FORCE_COLOR=1
PROMPT_STR=$'\e[1;34m❯\e[0m '

typeit() {
  printf '%s' "$PROMPT_STR"
  local text="$1" i
  for ((i = 1; i <= ${#text}; i++)); do
    printf '%s' "${text[$i]}"
    sleep 0.035
  done
  printf '\n'
}

say() {
  printf '%s' "$PROMPT_STR"
  printf '\e[2m# %s\e[0m\n' "$1"
  sleep 0.6
}

clear
say "anyplex — LiteLLM for managed agents"
say "one session interface over Anthropic, OpenAI, Gemini, Cursor"
sleep 1.5
typeit "pnpm add anyplex"
printf '\e[2m+ anyplex 0.3.0\e[0m\n'
sleep 1.5
clear

typeit "bat --style=plain --language=ts --line-range 24:37 examples/switch.ts"
bat --style=plain --language=ts --line-range 24:37 --color=always examples/switch.ts
sleep 6
clear

typeit "pnpm example examples/switch.ts anthropic/claude-haiku-4-5"
pnpm -s example examples/switch.ts anthropic/claude-haiku-4-5
sleep 2

typeit "pnpm example examples/switch.ts google/gemini-3.8-flash"
pnpm -s example examples/switch.ts google/gemini-3.8-flash 2>/dev/null
sleep 2
clear

say "same code, four runtimes:  anthropic/  openai/  google/  cursor/"
say "npm i anyplex        github.com/leepokai/anyplex"
sleep 4
